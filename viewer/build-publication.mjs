import fs from 'node:fs';
import path from 'node:path';

/** Install staged files and directories, restoring earlier outputs if any rename fails. */
export function publishViewerBuild(staging,artifacts) {
  const backups=[];
  try {
    for (const [source,destination] of artifacts) {
      const state={destination,backup:null,installed:false};
      backups.push(state);
      const existing=fs.lstatSync(destination,{throwIfNoEntry:false});
      if(existing) {
        const directory=fs.statSync(source).isDirectory();
        if(existing.isSymbolicLink()||existing.isDirectory()!==directory)
          throw new Error(`Unexpected artifact at ${destination}`);
        const backup=path.join(staging,`backup-${backups.length}`);
        if(directory)fs.renameSync(destination,backup);
        else fs.copyFileSync(destination,backup,fs.constants.COPYFILE_EXCL);
        state.backup=backup;
      }
      fs.renameSync(source,destination);
      state.installed=true;
    }
  } catch(error) {
    for(const {destination,backup,installed} of backups.reverse()) {
      if(installed)fs.rmSync(destination,{recursive:true});
      if(backup)fs.renameSync(backup,destination);
    }
    throw error;
  }
}
