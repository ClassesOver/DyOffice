import {config} from 'zod'

// 在工作簿工具创建 schema 前禁用 JIT，避免严格 CSP 下的 eval 探测。
config({jitless:true})
