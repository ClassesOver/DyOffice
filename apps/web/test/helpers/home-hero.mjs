// Office tool-flow fixtures keep their provider responses for the document task.
// The generated homepage copy has its own end-to-end gateway acceptance test.
export function isHomeHeroRequest(request){
 return request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/ai/turns'&&request.postDataJSON()?.request?.system?.startsWith('Write brief, warm homepage copy for DyOffice,')
}
export async function stubHomeHero(page){
 await page.route('**/api/v1/ai/turns',route=>isHomeHeroRequest(route.request())?route.fulfill({status:503,contentType:'application/json',body:'{"error":"Decorative copy unavailable in this fixture"}'}):route.continue())
}
