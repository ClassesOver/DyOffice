// 仅在已安装的 DBHub 2.1.0 StarRocks 子进程中加载。它已有为 Doris 提供的
// 非事务型只读路径；StarRocks 同样不支持 START TRANSACTION READ ONLY。
// 保留 DBHub 的 readonly SQL 分类、超时和行数限制，不修改磁盘中的依赖。
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const chunk = resolve(dirname(realpathSync(process.argv[1])), 'chunk-JMHM2U5L.js')
const source = readFileSync(chunk, 'utf8')
if (createHash('sha256').update(source).digest('hex') !== '4904ecab3fad19fc5c36dc8ec4aaa11f0753d66b4284e65ee468c5261af886d7') {
  throw new Error('Unsupported DBHub StarRocks connector version')
}
const url = pathToFileURL(chunk).href
registerHooks({
  load(specifier, context, next) {
    if (specifier !== url) return next(specifier, context)
    return { format: 'module', shortCircuit: true, source: source.replace(
      'if (isDorisVersionComment(versionComment)) {', 'if (process.env.DYOFFICE_DBHUB_DIALECT === "starrocks" || isDorisVersionComment(versionComment)) {',
    ).replace('Apache Doris detected. Doris cannot', 'StarRocks configured. StarRocks cannot') }
  },
})
