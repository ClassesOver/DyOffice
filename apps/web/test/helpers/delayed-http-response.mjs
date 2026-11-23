// Delay the first matching response's final write on the real HTTP connection.
// Release in fixture teardown as well as the test's success path.
export function holdFirstResponseEnd(matches, observeEnd = () => {}) {
  let reached, release, matched = false
  const started = new Promise(resolve => { reached = resolve })
  const gate = new Promise(resolve => { release = resolve })
  return {
    started, release,
    intercept(req,res) {
      if (matched || !matches(req)) return
      matched = true
      const end = res.end
      res.end = function(...args) {
        res.end = end
        observeEnd(res.statusCode)
        reached(res.statusCode)
        void gate.then(() => {
          if (!res.destroyed) end.apply(res,args)
        })
        return res
      }
      return true
    },
  }
}
