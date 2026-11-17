import assert from 'node:assert/strict'
/** Test-only admission; restrictedFixture creates and cleans a separate database.
 * Neither an arbitrary env value nor a test-looking database name grants access. */
export function assertDisposableSourceDatabase(value) {
 let url
 try {url=typeof value==='string'?new URL(value):null}catch{}
 assert.ok(url && url.protocol==='postgresql:' && url.hostname==='127.0.0.1' &&
  ['55432','55433'].includes(url.port) && url.pathname==='/dyoffice_test' &&
  url.username==='postgres' && url.password==='dyoffice-ci-test-only' &&
  !url.search && !url.hash &&
  value===`postgresql://postgres:dyoffice-ci-test-only@127.0.0.1:${url.port}/dyoffice_test`,
  'Use only the designated disposable PostgreSQL (CI 55432 or local 55433)')
}
