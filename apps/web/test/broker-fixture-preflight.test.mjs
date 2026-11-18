import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {requireRunnableBrokerFixture} from './helpers/broker-fixture-preflight.mjs'

test('preflight refuses absent, non-executable, invalid and wrong-exit artifacts',t=>{
 const dir=mkdtempSync(join(tmpdir(),'broker-preflight-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const path=join(dir,'fixture')
 const refuses=()=>assert.throws(()=>requireRunnableBrokerFixture(path),/BROKER_FIXTURE_PREREQUISITE/)
 refuses()
 writeFileSync(path,'#!/bin/sh\nexit 78\n',{mode:0o600});refuses()
 chmodSync(path,0o700);writeFileSync(path,'invalid executable');refuses()
 writeFileSync(path,'#!/bin/sh\nexit 0\n');refuses()
 writeFileSync(path,'#!/bin/sh\nexec /bin/sleep 5\n');refuses()
 writeFileSync(path,'#!/bin/sh\nexit 78\n');assert.doesNotThrow(()=>requireRunnableBrokerFixture(path))
})
