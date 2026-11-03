"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { engine, freshTmpDir, MOCK } = require('./helpers/env');

async function isolated(fn) {
  const old = process.env.ULTRACODE_STATE_DIR;
  const depth = process.env.ULTRACODE_DEPTH;
  process.env.ULTRACODE_DEPTH = "0";
  delete process.env.ULTRACODE_STATE_DIR;
  const cwd = freshTmpDir('storage-cwd-');
  try { await fn(cwd); } finally {
    if (depth === undefined) delete process.env.ULTRACODE_DEPTH;
    else process.env.ULTRACODE_DEPTH = depth;
    if (old === undefined) delete process.env.ULTRACODE_STATE_DIR;
    else process.env.ULTRACODE_STATE_DIR = old;
    await fs.rm(cwd, {recursive:true, force:true});
  }
}

test('default journals and snapshots are local; auth home is independent', () => isolated(async cwd => {
  const home = freshTmpDir('storage-auth-');
  const r = await engine.runScript({cwd, codex_home:home, source:'return 7;', ui:false});
  assert.equal(r.state_dir, path.join(cwd,'.codex','ultracode'));
  assert.equal(r.state_path, path.join(r.state_dir,'runs',`${r.id}.json`));
  assert.equal(r.script_path, path.join(r.state_dir,'scripts',`${r.id}.workflow.js`));
  await assert.rejects(fs.stat(path.join(home,'ultracode','runs')), {code:'ENOENT'});
}));

test('options > environment > cwd; relative roots resolve against workflow cwd', () => isolated(async cwd => {
  assert.equal(engine.stateDir({cwd}), path.join(cwd,'.codex','ultracode','runs'));
  process.env.ULTRACODE_STATE_DIR = 'env-state';
  assert.equal(engine.stateDir({cwd}), path.join(cwd,'env-state','runs'));
  assert.equal(engine.stateDir({cwd,state_dir:'explicit'}), path.join(cwd,'explicit','runs'));
  const home = freshTmpDir('legacy-home-');
  assert.equal(engine.stateDir(home), path.join(home,'ultracode','runs'));
}));

test('status latest and resume use selected root; copied state path is rebound', () => isolated(async cwd => {
  const opts = {cwd,state_dir:'journal',codex_bin:MOCK,ui:false,workers_spec:[{prompt:'test'}]};
  const r = await engine.runWorkflow(opts);
  assert.equal(r.state_dir,path.join(cwd,'journal'));
  assert.equal((await engine.readWorkflow({cwd,state_dir:'journal'})).id,r.id);
  assert.equal((await engine.readWorkflow({...opts,workflow_id:r.id})).id,r.id);
  const copy = path.join(cwd,'copy','runs',`${r.id}.json`);
  await fs.mkdir(path.dirname(copy),{recursive:true});
  await fs.writeFile(copy,JSON.stringify({...r,status:'failed',workers:r.workers.map(w=>({...w,status:'completed'}))}));
  const resumed = await engine.resumeWorkflow({state_path:copy,ui:false,codex_bin:MOCK});
  assert.equal(resumed.state_path,copy);
  assert.equal(resumed.state_dir,path.join(cwd,'copy'));
}));

test('nested scripts inherit pinned absolute state root even with child cwd', () => isolated(async cwd => {
  const child = path.join(cwd,'child'); await fs.mkdir(child);
  const r = await engine.runScript({cwd,state_dir:'journal',ui:false,source:`return await workflow({source:'return 3;',cwd:${JSON.stringify(child)},ui:false});`});
  assert.equal(r.result.state_dir,path.join(cwd,'journal'));
  assert.equal(r.result.cwd,child);
}));

test('mock worker receives auth home through execution and forced resume', () => isolated(async cwd => {
  const { withMockEnv, readInvocations } = require('./helpers/env');
  const home = path.join(cwd,'auth');
  const sessions = path.join(cwd,'sessions');
  await withMockEnv({MOCK_CODEX_SESSION_DIR:sessions}, async () => {
    const opts = {cwd,codex_home:home,codex_bin:MOCK,state_dir:'state',ui:false};
    const r = await engine.runWorkflow({...opts,workers_spec:[{prompt:'auth',schema:null}]});
    assert.equal(r.status,'completed', JSON.stringify(r.workers));
    await engine.resumeWorkflow({...opts,state_path:r.state_path,force_steps:['0']});
    const calls = readInvocations(sessions);
    assert.equal(calls.length,2);
    assert.ok(calls.every(c => c.codex_home === home));
  });
}));

test('DAG and fanout use the same absolute state root', () => isolated(async cwd => {
  const opts = {cwd,state_dir:'state',ui:false,codex_bin:MOCK};
  const dag = await engine.runPipelineSpec({...opts,steps:[{id:'one',prompt:'one'}]});
  const fan = await engine.runWorkflow({...opts,task:'one',workers:1});
  for (const r of [dag,fan]) {
    assert.equal(r.state_dir,path.join(cwd,'state'));
    assert.equal(path.dirname(r.state_path),path.join(cwd,'state','runs'));
  }
}));

test('script replay loaded by explicit path pins nested runs to loaded storage', () => isolated(async cwd => {
  const r = await engine.runScript({cwd,state_dir:'old',ui:false,source:'return 1;'});
  process.env.ULTRACODE_STATE_DIR = 'different';
  const replay = await engine.runScript({cwd,state_path:r.state_path,ui:false,source:"return await workflow({source:'return 2;',ui:false});"});
  assert.equal(replay.state_dir,r.state_dir);
  assert.equal(replay.result.state_dir,r.state_dir);
}));

test('CLI preserves state-dir and dashboard configuration', () => {
  const cli = require('../scripts/ultracode-cli');
  const { options } = cli.dispatchParse(['--source','return 1;','--state-dir','journal','--cwd','project','--ui-port','4231','--codex-home','auth']);
  cli.coerce(options,'exec');
  assert.equal(options.state_dir,'journal');
  assert.equal(options.codex_home,'auth');
  assert.equal(options.ui,true);
  assert.equal(options.ui_port,4231);
});

test('legacy journals require explicit state root; no migration or auth-home lookup', () => isolated(async cwd => {
  const home = path.join(cwd,'auth');
  const legacyRoot = path.join(home,'ultracode');
  const file = path.join(legacyRoot,'runs','old.json');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,JSON.stringify({id:'old',status:'completed',cwd,workers:[],state_path:'/stale/path.json'}));
  assert.equal((await engine.readWorkflow({cwd,codex_home:home})).status,'missing');
  const r = await engine.readWorkflow({cwd,state_dir:legacyRoot,workflow_id:'old'});
  assert.equal(r.state_path,file);
  assert.equal(r.state_dir,legacyRoot);
  await assert.rejects(fs.stat(path.join(cwd,'.codex','ultracode')), {code:'ENOENT'});
}));

test('CLI creates local snapshots and reads explicit path from another cwd', () => isolated(async cwd => {
  // File-backed stdout avoids this worker sandbox's pipe capture limitation.
  const syncFs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const cli = path.resolve(__dirname,'../scripts/ultracode-cli.js');
  function call(args, commandCwd) {
    const output = path.join(cwd,'cli-output');
    const fd = syncFs.openSync(output,'w');
    let result;
    try {
      result = spawnSync(process.execPath,[cli,...args],{cwd:commandCwd,env:{...process.env,CODEX_CLI_PATH:MOCK,ULTRACODE_UI:'0',ULTRACODE_NO_AUTO_UPDATE:'1'},stdio:['ignore',fd,fd]});
    } finally { syncFs.closeSync(fd); }
    const raw = syncFs.readFileSync(output,'utf8');
    assert.equal(result.status,0,raw);
    return JSON.parse(raw);
  }
  const r = call(['--source','return 9;','--state-dir','state','--cwd',cwd],cwd);
  assert.equal(r.state_dir,path.join(cwd,'state'));
  const read = call(['status','--state-path',r.state_path],'/tmp');
  assert.equal(read.id,r.id);
  assert.equal(read.state_dir,r.state_dir);
  const latest = call(['status','--cwd',cwd,'--state-dir','state'],'/tmp');
  assert.equal(latest.id,r.id);
}));
