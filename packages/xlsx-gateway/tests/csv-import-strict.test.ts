import {expect,it} from 'vitest'
import {csvRows,parseCsv} from '../src/gateway/csv-import'
const strict=(text:string)=>[...csvRows(text,',',{strict:true})]
it('strict rejects malformed quoting without changing permissive default',()=>{
 for(const text of ['"open','a"b','"a"junk','"" "'])expect(()=>strict(text)).toThrow()
 expect(parseCsv('"open',',')).toEqual([['open']])
 expect(strict('"a,b","a""b"\r\n"line\nnext",007')).toEqual([['a,b','a"b'],['line\nnext','007']])
})
it('strict preserves empty records, including trailing blanks, but not terminal newline as a new row',()=>{
 expect(strict('a\n')).toEqual([['a']]);expect(strict('a\n\n')).toEqual([['a'],['']]);expect(strict('""')).toEqual([['']]);expect(strict('\n')).toEqual([['']]);expect(strict('')).toEqual([])
 expect(strict('a,\r\n,\r\n')).toEqual([['a',''],['','']])
 expect(parseCsv('a\n\n',',')).toEqual([['a']])
})
it('strict does not sniff or strip separator declarations',()=>{expect(strict('sep=;\na;b')).toEqual([['sep=;'],['a;b']])})
