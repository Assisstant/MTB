import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorReaderSettings, readerStatements } from '../src/lib/mirror-reader-setup.js';

const env = () => ({ DATABASE_URL:'postgresql://app:unused@localhost:5432/therapy_dev',
    MTB_MIRROR_READER_DATABASE_URL:`postgresql://test_reader:${'a'.repeat(40)}@localhost:5432/test_mirror`,
    MTB_MIRROR_TARGET_DATABASE_URL:'postgresql://test_sync:unused@localhost:5432/test_mirror',
    MTB_MIRROR_TARGET_DATABASE:'test_mirror' });
test('reader setup only accepts a separate local mirror and a distinct role',()=>{
    assert.equal(mirrorReaderSettings(env()).database,'test_mirror');
    for (const [key,value] of [
        ['MTB_MIRROR_READER_DATABASE_URL',env().MTB_MIRROR_READER_DATABASE_URL.replace('localhost','example.com')],
        ['MTB_MIRROR_TARGET_DATABASE','therapy_dev'],
        ['DATABASE_URL',env().MTB_MIRROR_TARGET_DATABASE_URL],
        ['MTB_MIRROR_READER_DATABASE_URL',env().MTB_MIRROR_READER_DATABASE_URL.replace('test_reader','test_sync')],
        ['MTB_MIRROR_READER_DATABASE_URL',env().MTB_MIRROR_READER_DATABASE_URL.replace('a'.repeat(40),'REPLACE_PASSWORD')]
    ]) assert.throws(()=>mirrorReaderSettings({...env(),[key]:value}));
});
test('reader SQL grants SELECT only and excludes credentials, even with RLS',()=>{
    const sql=readerStatements(mirrorReaderSettings(env()),['app_state','employees','staff_accounts','portal_links','schema_migrations','mirror_sync_state']);
    assert.ok(sql.some(s=>s.includes('FOR SELECT TO test_reader USING (true)')));
    assert.ok(sql.some(s=>s.includes('NOBYPASSRLS')));
    assert.ok(sql.some(s=>s.includes('default_transaction_read_only = on')));
    assert.ok(!sql.some(s=>/staff_accounts|portal_links|therapy_dev/.test(s)));
    assert.ok(!sql.some(s=>/GRANT (ALL|INSERT|UPDATE|DELETE)/.test(s)));
    assert.throws(()=>readerStatements(mirrorReaderSettings(env()),['unknown']));
});
test('reader password is quoted without becoming executable SQL',()=>{
    const e=env();e.MTB_MIRROR_READER_DATABASE_URL=e.MTB_MIRROR_READER_DATABASE_URL.replace('a'.repeat(40),encodeURIComponent("x'"+'a'.repeat(40)));
    assert.ok(readerStatements(mirrorReaderSettings(e),['app_state','schema_migrations'])[0].includes("PASSWORD 'x''"));
});
