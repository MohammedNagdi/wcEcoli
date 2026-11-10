import {test,expect} from '@playwright/test'

for(const width of [390,1440])for(const theme of ['light','dark'] as const)test(`published lists scroll with wheel ${width}px ${theme}`,async({page},info)=>{
  await page.setViewportSize({width,height:720})
  await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
  for(const path of ['/results','/experiments']){
    await page.goto(path)
    const last=page.getByText('wt-cut-aa',{exact:true}).first()
    await expect(last).toBeAttached()
    const main=page.locator('main')
    expect(await main.evaluate(e=>getComputedStyle(e).overflowY)).toBe('auto')
    expect(await main.evaluate(e=>e.scrollHeight>e.clientHeight)).toBe(true)
    await page.mouse.move(width-40,350)
    await page.mouse.wheel(0,700)
    await expect.poll(()=>main.evaluate(e=>e.scrollTop)).toBeGreaterThan(0)
    for(let i=0;i<10 && !(await last.isVisible()&&await last.evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight));i++)await page.mouse.wheel(0,700)
    await expect.poll(()=>last.evaluate(e=>e.getBoundingClientRect().bottom<=innerHeight)).toBe(true)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
    await page.screenshot({path:info.outputPath(path.slice(1)+'-scrolled.png')})
  }
})
