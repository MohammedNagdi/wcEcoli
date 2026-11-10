import {test,expect} from '@playwright/test'

for(const width of [390,1440])for(const theme of ['light','dark'] as const)test(`homepage actions remain readable ${width}px ${theme}`,async({page},info)=>{
  await page.setViewportSize({width,height:900})
  await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'})
  await page.goto('/')
  const primary=page.getByRole('link',{name:'Explore published results',exact:true})
  const secondary=page.getByRole('link',{name:'Design an experiment',exact:true})
  await expect(primary).toBeVisible()
  const contrast=async(link:typeof primary)=>link.evaluate(e=>{
    const s=getComputedStyle(e)
    const luminance=(color:string)=>{
      const rgb=color.match(/[\d.]+/g)!.slice(0,3).map(v=>Number(v)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4)
      return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722
    }
    const text=luminance(s.color),background=luminance(s.backgroundColor)
    return (Math.max(text,background)+.05)/(Math.min(text,background)+.05)
  })
  for(const link of [primary,secondary]){
    expect(await contrast(link)).toBeGreaterThanOrEqual(4.5)
    await link.hover()
    // Allow the site's short colour transition to finish before measuring contrast.
    await expect.poll(()=>contrast(link)).toBeGreaterThanOrEqual(4.5)
    if(link===primary)await expect(link).toHaveCSS('color','rgb(255, 255, 255)')
    await page.screenshot({path:info.outputPath(link===primary?'primary-hover.png':'secondary-hover.png')})
  }
  await page.mouse.move(0,0)
  await primary.focus()
  await expect(primary).toBeFocused()
  await expect(primary).toHaveCSS('outline-style','solid')
  await expect(primary).toHaveCSS('outline-width','2px')
  await page.screenshot({path:info.outputPath('keyboard-focus.png')})
  await page.keyboard.press('Tab')
  await expect(secondary).toBeFocused()
  await expect(secondary).toHaveCSS('outline-style','solid')
  await expect(page.locator('.explorer-home-hero')).not.toContainText('seed 0')
  await expect(page.locator('.explorer-home-hero')).not.toContainText('47 sequential')
  const footer=page.locator('footer')
  await expect(footer.getByRole('link',{name:'Explorer guide',exact:true})).toHaveAttribute('href','/guide')
  await expect(footer).toContainText('Save drafts in this browser, or download a JSON copy to keep or share.')
  await expect(footer).not.toContainText('No accounts')
  await footer.scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('footer.png')})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
  await primary.click()
  await expect(page).toHaveURL(/\/results$/)
  await page.goto('/')
  await secondary.click()
  await expect(page).toHaveURL(/\/experiments\/new$/)
})
