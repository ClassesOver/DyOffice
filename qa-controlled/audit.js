// QA-only passive page observation. No fetch/XHR overrides or external reporting.
const output = document.getElementById('qa-network-audit')
const resources = new Set(),
  violations = new Set()
let dropped = 0
function locationOf(raw) {
  try {
    const u = new URL(raw, location.href)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin + u.pathname
    return ['inline', 'eval', 'self'].includes(raw) ? raw : u.protocol
  } catch {
    return 'unparseable'
  }
}
function record(set, value) {
  if (set.has(value)) return
  if (set.size >= 256) {
    dropped++
    return
  }
  set.add(value)
}
function render() {
  if (output)
    output.textContent = JSON.stringify(
      {
        scope: '仅本页面资源与 CSP 事件；不覆盖扩展或浏览器全部网络。URL 不含查询或片段。',
        resources: [...resources].sort(),
        cspViolations: [...violations].sort(),
        dropped,
      },
      null,
      2,
    )
}
try {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) record(resources, locationOf(entry.name))
    render()
  })
  observer.observe({ type: 'resource', buffered: true })
} catch {
  record(violations, 'PerformanceObserver unavailable')
}
document.addEventListener('securitypolicyviolation', (event) => {
  record(
    violations,
    String(event.effectiveDirective || event.violatedDirective) +
      ': ' +
      locationOf(event.blockedURI),
  )
  render()
})
render()
