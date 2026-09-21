import {join} from 'node:path';
import {managedLayout} from './systemd.js';

/** Fixed root-controlled paths shared by the controller and service-user helper. */
export const upgradePaths=Object.freeze({
 data:managedLayout.data,config:managedLayout.config,current:managedLayout.current,controller:managedLayout.controller,
 releases:managedLayout.releases,stagedRelease:'/opt/mate/staged-release',stagedConfig:'/etc/mate/staged-config.json',
 checkpoints:managedLayout.checkpoints,service:managedLayout.service,
});
export type UpgradePaths={ [K in keyof typeof upgradePaths]:string };
export function upgradeCheckpointPath(upgradeId:string,kind:'rollback'|'candidate'):string{return join(upgradePaths.checkpoints,`upgrade-${upgradeId}-${kind}`);}
