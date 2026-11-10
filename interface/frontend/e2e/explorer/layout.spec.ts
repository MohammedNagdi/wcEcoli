import {test,expect} from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

for(const width of [390,1440])for(const theme of ['light','dark'])test(`existing visual system ${width}px ${theme}`,async({page},info)=>{
  await page.setViewportSize({width,height:1000});await page.emulateMedia({reducedMotion:'reduce',colorScheme:theme as 'light'|'dark'});await page.addInitScript(t=>localStorage.setItem('wcecoli.theme',t),theme)
  for(const path of ['/','/results','/experiments/new','/experiments/batch','/environment-builder','/guide']){
    await page.goto(path);await page.waitForLoadState('networkidle')
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
    const results=await new AxeBuilder({page}).analyze()
    expect(results.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([])
    await page.screenshot({path:info.outputPath(path.replace(/[^a-z]/g,'_')+'.png'),fullPage:true})
  }
  await page.goto('/experiments/new');await page.getByLabel('Name',{exact:true}).fill('Keyboard draft');if(width<640)await page.getByRole('button',{name:'Open workspace navigation',exact:true}).click();await page.getByRole('link',{name:'Results',exact:true}).first().click()
  const dialog=page.getByRole('alertdialog',{name:'Leave unsaved personal draft?'});await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'Stay',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible()
})
