import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const child=spawn(electronPath,[path.join(root,'scripts','instagram-sandbox.mjs')],{
  cwd:root,env:{...process.env,INSTA_TOOLBOX_SANDBOX_INTERACTIVE:process.argv.includes('--interactive')?'1':process.env.INSTA_TOOLBOX_SANDBOX_INTERACTIVE},stdio:'inherit',windowsHide:true,
});
child.once('error',error=>{console.error(error);process.exitCode=1;});
child.once('exit',(code,signal)=>{if(signal)console.error(`Sandbox exited after ${signal}`);process.exitCode=code??1;});
