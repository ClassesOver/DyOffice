import { getCsrfToken } from './csrf'
const form = document.querySelector('form')!,
  status = document.querySelector('[role=status]')!
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = form.querySelector('button')!
  button.disabled = true
  try {
    const body = Object.fromEntries(new FormData(form))
    const r = await fetch('/api/v1/auth/login', {
      method: 'POST',
      mode: 'same-origin',
      redirect: 'error',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-csrf-token': await getCsrfToken() },
      body: JSON.stringify(body),
    })
    if (!r.ok || r.redirected) throw Error('登录失败 ' + r.status)
    location.assign('/qa/controlled')
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '登录失败'
    button.disabled = false
  }
})
