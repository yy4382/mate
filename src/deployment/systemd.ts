import { basename, resolve } from 'node:path';

export const managedLayout = Object.freeze({
  releases: '/opt/mate/releases', current: '/opt/mate/current', controller: '/opt/mate/controller', previous: '/opt/mate/previous', configDir: '/etc/mate',
  config: '/etc/mate/mate.json', environment: '/etc/mate/mate.env', manifest: '/etc/mate/workspaces.json',
  data: '/var/lib/mate', volumes: '/var/lib/mate-volumes', checkpoints: '/var/backups/mate',
  service: '/etc/systemd/system/mate.service', wrapper: '/usr/local/sbin/matectl',
});

export interface ManagedMount {
  root: string;
  backingFile: string;
  unitName: string;
}

function lineList(values: readonly string[]): string {
  return values.length ? values.join(' ') : '';
}

export function renderMountUnit(mount: ManagedMount): string {
  if (!mount.unitName.endsWith('.mount') || !mount.unitName || resolve(mount.root) !== mount.root || resolve(mount.backingFile) !== mount.backingFile || /[\0\r\n]/.test(mount.root + mount.backingFile)) {
    throw new Error('Invalid managed mount unit input');
  }
  return `[Unit]\nDescription=Mate managed workspace\nBefore=mate.service\n\n[Mount]\nWhat=${mount.backingFile}\nWhere=${mount.root}\nType=ext4\nOptions=loop,rw,nodev,nosuid\nTimeoutSec=90\n\n[Install]\nWantedBy=multi-user.target\n`;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }

export interface TransientUnitOptions { environment?:boolean; writablePaths?:readonly string[] }
export function transientUnitProperties(release:string,externalRoots:readonly string[]=[],options:TransientUnitOptions={}):string[]{
  const additional=options.writablePaths??[],paths=[managedLayout.data,...externalRoots,...additional];
  if(resolve(release)!==release||[...externalRoots,...additional].some(path=>resolve(path)!==path))throw new Error('Invalid transient unit path');
  return ['--quiet','--collect','--wait','--pipe',`--working-directory=${release}`,
    '--property=User=mate','--property=Group=mate','--property=SupplementaryGroups=docker',
    ...(options.environment?[`--property=EnvironmentFile=${managedLayout.environment}`]:[]),
    '--property=UMask=0077','--property=NoNewPrivileges=yes','--property=PrivateTmp=yes','--property=PrivateDevices=yes','--property=ProtectHome=yes','--property=ProtectSystem=strict',
    '--property=ProtectKernelTunables=yes','--property=ProtectKernelModules=yes','--property=ProtectControlGroups=yes','--property=CapabilityBoundingSet=','--property=RestrictSUIDSGID=yes','--property=LockPersonality=yes',
    ...paths.map(path=>`--property=ReadWritePaths=${path}`)];
}

export function renderService(mounts: readonly ManagedMount[], memoryMaxMiB: number, externalRoots: readonly string[]): string {
  const names = mounts.map(item => item.unitName);
  if (new Set(names).size !== names.length) throw new Error('Duplicate mount unit name');
  if (!Number.isInteger(memoryMaxMiB) || memoryMaxMiB < 128 || externalRoots.some(root => resolve(root) !== root)) throw new Error('Invalid service resource plan');
  const requires = lineList(['docker.service', ...names]);
  const writable = lineList(['/var/lib/mate', ...externalRoots]);
  return `[Unit]\nDescription=Mate autonomous agent daemon\nWants=network-online.target\nAfter=network-online.target ${requires}\nRequires=${requires}\nRequiresMountsFor=/var/lib/mate /etc/mate\n\n[Service]\nType=notify\nNotifyAccess=all\nUser=mate\nGroup=mate\nSupplementaryGroups=docker\nWorkingDirectory=/opt/mate/current\nEnvironmentFile=/etc/mate/mate.env\nExecStart=/usr/bin/node /opt/mate/current/dist/src/main.js start /etc/mate/mate.json\nRestart=on-failure\nRestartSec=5\nTimeoutStartSec=900\nTimeoutStopSec=120\nKillMode=mixed\nMemoryMax=${memoryMaxMiB}M\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectHome=yes\nProtectSystem=strict\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nCapabilityBoundingSet=\nReadWritePaths=${writable}\nRestrictSUIDSGID=yes\nLockPersonality=yes\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export function renderMaintenanceWrapper(externalRoots: readonly string[] = [], upgradeController: string = managedLayout.current): string {
  if(resolve(upgradeController)!==upgradeController||/[\0\r\n]/.test(upgradeController))throw new Error('Invalid upgrade controller path');
  if (externalRoots.some(root => resolve(root) !== root)) throw new Error('Invalid maintenance workspace root');
  const unitProperties=transientUnitProperties(managedLayout.current,externalRoots).map(shellQuote).join(' '),doctorProperties=transientUnitProperties(managedLayout.current,externalRoots,{environment:true}).map(shellQuote).join(' ');
  return `#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
CONFIG=/etc/mate/mate.json
ENTRY=/opt/mate/current/dist/src/main.js
CHECKPOINTS=/var/backups/mate

[ "$(id -u)" -eq 0 ] || { echo "matectl must be run as root" >&2; exit 1; }

inactive() {
  if /usr/bin/systemctl is-active --quiet mate.service; then
    echo "mate.service must be stopped" >&2
    exit 1
  fi
}

checkpoint_name() {
  case "$1" in
    ''|*[!A-Za-z0-9._-]*|.*|-*) echo "Invalid checkpoint name" >&2; exit 1 ;;
  esac
  [ "\${#1}" -le 64 ] || { echo "Checkpoint name is too long" >&2; exit 1; }
}

case "${'$'}{1-}" in
  candidate|resume|rollback|activate|finalize|fix-forward)
    [ "${'$'}#" -eq 1 ] || { echo "Upgrade commands take no arguments" >&2; exit 1; }
    exec /usr/bin/node ${shellQuote(`${upgradeController}/dist/src/deployment/cli.js`)} "$1"
    ;;

  status|logs)
    [ "${'$'}#" -eq 1 ] || { echo "Read-only commands take no arguments" >&2; exit 1; }
    exec /usr/bin/node ${shellQuote(`${upgradeController}/dist/src/deployment/cli.js`)} "$1"
    ;;
  doctor)
    [ "${'$'}#" -eq 1 ] || { echo "Usage: matectl doctor" >&2; exit 1; }
    exec /usr/bin/systemd-run ${doctorProperties} \\
      --property=ReadOnlyPaths=/etc/mate /usr/bin/node "$ENTRY" doctor "$CONFIG"
    ;;
  offline-probe)
    [ "${'$'}#" -eq 1 ] || { echo "Usage: matectl offline-probe" >&2; exit 1; }
    inactive
    exec /usr/bin/systemd-run ${unitProperties} \\
      /usr/bin/node "$ENTRY" offline-probe "$CONFIG"
    ;;
  backup)
    [ "${'$'}#" -eq 2 ] || { echo "Usage: matectl backup NAME" >&2; exit 1; }
    inactive; checkpoint_name "$2"
    target="$CHECKPOINTS/$2"
    [ ! -e "$target" ] || { echo "Checkpoint already exists" >&2; exit 1; }
    /usr/bin/install -d -o mate -g mate -m 0700 "$target"
    if ! /usr/bin/systemd-run ${unitProperties} \\
      --property=ReadWritePaths=/var/backups/mate /usr/bin/node "$ENTRY" backup "$CONFIG" "$target"; then
      echo "Backup failed; incomplete checkpoint retained for identity-safe cleanup" >&2
      exit 1
    fi
    uid=$(/usr/bin/id -u mate); gid=$(/usr/bin/id -g mate)
    exec /usr/bin/node "$ENTRY" checkpoint-seal "$CONFIG" "$target" "$uid" "$gid"
    ;;
  restore)
    [ "${'$'}#" -eq 2 ] || [ "${'$'}#" -eq 4 ] || { echo "Usage: matectl restore NAME [--replace CURRENT_NAME]" >&2; exit 1; }
    inactive; checkpoint_name "$2"; source="$CHECKPOINTS/$2"
    [ -d "$source" ] || { echo "Checkpoint does not exist" >&2; exit 1; }
    if [ "${'$'}#" -eq 4 ]; then
      [ "$3" = --replace ] || { echo "Unknown restore option" >&2; exit 1; }
      checkpoint_name "$4"; current="$CHECKPOINTS/$4"; [ -d "$current" ] || { echo "Current checkpoint does not exist" >&2; exit 1; }
      exec /usr/bin/systemd-run ${unitProperties} \\
        --property=ReadOnlyPaths=/var/backups/mate /usr/bin/node "$ENTRY" restore "$CONFIG" "$source" --replace "$current"
    fi
    exec /usr/bin/systemd-run ${unitProperties} \\
      --property=ReadOnlyPaths=/var/backups/mate /usr/bin/node "$ENTRY" restore "$CONFIG" "$source"
    ;;
  *)
    echo "Usage: matectl status|logs|doctor|offline-probe|backup NAME|restore NAME [--replace CURRENT_NAME]" >&2
    exit 1
    ;;
esac
`;
}

export function assertSafeUnitName(value: string): void {
  if (!/^[A-Za-z0-9_.@\\-]+\.mount$/.test(value) || basename(value) !== value) throw new Error('Unsafe systemd mount unit name');
}
