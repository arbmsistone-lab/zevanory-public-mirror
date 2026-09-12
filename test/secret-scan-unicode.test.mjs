import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const scanner=fileURLToPath(new URL('../scripts/secret-scan.mjs',import.meta.url));
test('secret scan inspects Unicode tracked filenames and fails closed on unreadable files',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'zevanory-scanner-'));const ownedRoot=fs.realpathSync(root);
 try{assert.equal(spawnSync('git',['init','--quiet'],{cwd:root}).status,0);const name='informação-segurança.txt';fs.writeFileSync(path.join(root,name),'-----BEGIN '+'PRIVATE KEY-----');assert.equal(spawnSync('git',['add','--',name],{cwd:root}).status,0);let result=spawnSync(process.execPath,[scanner],{cwd:root,encoding:'utf8'});assert.equal(result.status,1);assert.ok(JSON.parse(result.stderr).findings.some(f=>f.file===name));fs.writeFileSync(path.join(root,name),'fixture without secrets');result=spawnSync(process.execPath,[scanner],{cwd:root,encoding:'utf8'});assert.equal(result.status,0);fs.unlinkSync(path.join(root,name));result=spawnSync(process.execPath,[scanner],{cwd:root,encoding:'utf8'});assert.equal(result.status,1);assert.equal(JSON.parse(result.stderr).findings[0].pattern,'unreadable_file');}
 finally{assert.equal(fs.realpathSync(root),ownedRoot);assert.equal(path.dirname(ownedRoot),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(ownedRoot).startsWith('zevanory-scanner-'));fs.rmSync(ownedRoot,{recursive:true,force:true});}
});
