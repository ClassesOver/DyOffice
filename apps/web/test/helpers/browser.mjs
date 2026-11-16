import {chromium} from '@playwright/test'

// The default remains Playwright's pinned browser. Managed local verification may
// name an installed Chromium explicitly; record that version in the evidence.
export const launchTestBrowser = () => chromium.launch({
  ...(process.env.DYOFFICE_TEST_CHROMIUM_PATH ? {executablePath: process.env.DYOFFICE_TEST_CHROMIUM_PATH} : {}),
})
