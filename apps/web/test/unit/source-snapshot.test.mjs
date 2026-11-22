import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuerySnapshot, fitSnapshotRows } from '../../server/src/modules/sources/provenance.ts'
const input = () => ({ sourceId:'source-a', sourceVersion:1, schema:[{name:'amount', type:'number', unit:'元'}, {name:'period',type:'string'}], timezone:'Asia/Shanghai', rows:[{amount:12.5,period:'2026-11'}], sourceTruncated:false })
test('preserves values, unit, timezone and deterministic evidence hash', () => {
 const a=createQuerySnapshot(input()), b=createQuerySnapshot({...input(), rows:[{period:'2026-11',amount:12.5}]})
 assert.equal(a.sha256,b.sha256); assert.equal(a.rows[0].amount,12.5); assert.equal(a.schema[0].unit,'元'); assert.equal(a.timezone,'Asia/Shanghai')
 for (const change of [{timezone:'UTC'},{sourceId:'source-b'},{sourceVersion:2},{schema:[{name:'amount',type:'number',unit:'万元'},{name:'period',type:'string'}]}]) assert.notEqual(a.sha256,createQuerySnapshot({...input(),...change}).sha256)
})
test('explicit truncation at row limit and upstream truncation are preserved', () => {
 const a=createQuerySnapshot({...input(),rows:[...input().rows,...input().rows]}, {maxRows:1})
 assert.equal(a.rows.length,1); assert.equal(a.truncated,true)
 assert.equal(createQuerySnapshot(input(),{maxRows:1}).truncated,false)
 assert.equal(createQuerySnapshot({...input(),sourceTruncated:true}).truncated,true)
})
test('rejects invalid schema and cells instead of changing evidence', () => {
 for (const change of [{timezone:'Not/AZone'}, {sourceVersion:0}, {schema:[{name:'amount',type:'number'},{name:'amount',type:'number'}]}, {schema:[]}, {rows:[{amount:NaN,period:'x'}]}, {rows:[{amount:Infinity,period:'x'}]}, {rows:[{amount:'12',period:'x'}]}, {rows:[{amount:12}]}, {rows:[{amount:12,period:'x',password:'secret'}]}, {rows:[{amount:12,period:undefined}]}]) assert.throws(()=>createQuerySnapshot({...input(),...change}),/Invalid source snapshot/)
})
test('strict byte/row budgets fail closed and errors never echo data', () => {
 assert.throws(()=>createQuerySnapshot(input(),{maxBytes:1}),/Invalid source snapshot/)
 for (const options of [{maxRows:0},{maxRows:10001},{maxRows:NaN},{maxBytes:9000000}]) assert.throws(()=>createQuerySnapshot(input(),options),/Invalid source snapshot/)
 const secret='super-secret'; assert.throws(()=>createQuerySnapshot({...input(),rows:[{amount:secret,period:'x'}]}),e=>!e.message.includes(secret))
})
test('takes a frozen detached snapshot', () => {
 const source=input(), snap=createQuerySnapshot(source); source.rows[0].amount=99; source.schema[0].unit='美元';
 assert.equal(snap.rows[0].amount,12.5); assert.equal(snap.schema[0].unit,'元');
 assert.throws(()=>{snap.rows[0].amount=3},TypeError); assert.throws(()=>{snap.schema[0].unit='x'},TypeError)
})
test('byte budget includes hash envelope and counts UTF-8 bytes', () => {
 const value={...input(),rows:[{amount:12.5,period:'中文'}]}; const snap=createQuerySnapshot(value)
 const size=Buffer.byteLength(JSON.stringify(snap),'utf8')
 assert.ok(size>JSON.stringify(snap).length)
 assert.throws(()=>createQuerySnapshot(value,{maxBytes:size-1}),/Invalid source snapshot/)
 assert.equal(createQuerySnapshot(value,{maxBytes:size}).sha256,snap.sha256)
})
test('live rows are trimmed to the byte budget as a truncated prefix that the snapshot accepts', () => {
 const wide = Array.from({ length: 50 }, (_, i) => ({ amount: i, period: 'x'.repeat(200) }))
 const base = { ...input(), rows: wide }
 const full = createQuerySnapshot(base)
 const size = Buffer.byteLength(JSON.stringify({ version:1, sourceId:full.sourceId, sourceVersion:full.sourceVersion, schema:full.schema, timezone:full.timezone, rows:full.rows, truncated:full.truncated, sha256:full.sha256 }))
 const budget = Math.floor(size / 2)
 const fitted = fitSnapshotRows(base, { maxRows: 1000, maxBytes: budget })
 assert.equal(fitted.truncated, true)
 assert.ok(fitted.rows.length > 0 && fitted.rows.length < wide.length)
 assert.deepEqual(fitted.rows, wide.slice(0, fitted.rows.length))
 const snapshot = createQuerySnapshot({ ...base, rows: fitted.rows, sourceTruncated: true }, { maxRows: 1000, maxBytes: budget })
 assert.equal(snapshot.truncated, true)
 // One more row would not have fitted.
 assert.throws(() => createQuerySnapshot({ ...base, rows: wide.slice(0, fitted.rows.length + 1), sourceTruncated: true }, { maxRows: 1000, maxBytes: budget }), /Invalid source snapshot/)
 // Within budget nothing is trimmed; the row limit is left to createQuerySnapshot.
 assert.deepEqual(fitSnapshotRows(base, { maxRows: 10, maxBytes: 8_000_000 }), { rows: wide, truncated: false })
})
