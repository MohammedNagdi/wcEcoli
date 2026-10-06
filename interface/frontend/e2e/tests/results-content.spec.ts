import { test, expect } from '@playwright/test'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
const baseline = JSON.parse(readFileSync(new URL('../fixtures/results-content.json', import.meta.url), 'utf8')) as {entries:{text:string;count:number}[]}
test('existing Results and shared batch labels and explanatory text remain available',()=>{
 const counts=new Map<string,number>();const normalize=(s:string)=>s.replace(/\s+/g,' ').trim()
 const add=(s:string)=>{const text=normalize(s);if(text)counts.set(text,(counts.get(text)||0)+1)}
 for(const file of ['results/ResultsBrowserPage.tsx','experiments/BatchDashboard.tsx','results/ResultsPresentation.tsx']){
  const source=ts.createSourceFile(file,readFileSync(new URL('../../src/components/'+file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  function visit(n:ts.Node){if(ts.isJsxText(n))add(n.text);if(ts.isStringLiteral(n))add(n.text);ts.forEachChild(n,visit)}visit(source)
 }
 for(const entry of baseline.entries)expect(counts.get(entry.text)||0,entry.text).toBeGreaterThanOrEqual(entry.count)
})
