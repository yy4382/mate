/** Fixed filesystem locations for the Debian Linux-user deployment. */
export const managedLayout = Object.freeze({
  releases: '/opt/mate/releases',
  current: '/opt/mate/current',
  controller: '/opt/mate/controller',
  configDir: '/etc/mate',
  config: '/etc/mate/mate.json',
  environment: '/etc/mate/mate.env',
  data: '/var/lib/mate',
  checkpoints: '/var/backups/mate',
  service: '/etc/systemd/system/mate.service',
  wrapper: '/usr/local/sbin/matectl',
});
