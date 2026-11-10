import {createRequire} from 'node:module'
const {build}=createRequire(import.meta.resolve('vite'))('esbuild')
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
const directory=await mkdtemp(path.join(tmpdir(),'wcecoli-profiles-'))
try{
 for(const profile of ['local','explorer']){
  const outfile=path.join(directory,profile+'.cjs')
  await build({entryPoints:['tests/profiles.test.ts'],outfile,bundle:true,platform:'node',format:'cjs',define:{'import.meta.env':JSON.stringify({VITE_DEPLOYMENT_MODE:profile})},alias:{'@deployment/persistence':path.resolve(`src/deployment/persistence-${profile}.ts`)}})
  const result=spawnSync(process.execPath,['--test',outfile],{stdio:'inherit',env:{...process.env,TEST_PROFILE:profile}})
  if(result.status!==0)process.exitCode=1
 }
}finally{await rm(directory,{recursive:true,force:true})}
