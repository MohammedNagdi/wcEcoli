import {test,expect} from '@playwright/test'
import ts from 'typescript'
import {readFileSync} from 'node:fs'
const inventory = JSON.parse(readFileSync(new URL('../fixtures/environment-content.json', import.meta.url), 'utf8')) as { entries: {kind: string; text: string}[] }

test('all checkpoint text entries remain verbatim, including repeated passages',()=>{
 const source=ts.createSourceFile('builder.tsx',readFileSync(new URL('../../src/components/experiments/EnvironmentBuilderPage.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 const counts=new Map<string,number>();const normalize=(s:string)=>s.replace(/\s+/g,' ').trim()
 function add(kind:string,text:string){const key=kind+':'+normalize(text);counts.set(key,(counts.get(key)||0)+1)}
 function visit(n:ts.Node){if(ts.isJsxText(n)&&normalize(n.text))add('text',n.text);if(ts.isJsxAttribute(n)&&['label','tooltip','hint','placeholder','title'].includes(n.name.getText())&&n.initializer&&ts.isStringLiteral(n.initializer))add(n.name.getText(),n.initializer.text);if(ts.isVariableDeclaration(n)&&n.name.getText()==='DEPENDENCY_STEPS'){function data(v:ts.Node){if(ts.isStringLiteral(v))add('dependency',v.text);ts.forEachChild(v,data)}if(n.initializer)data(n.initializer)}ts.forEachChild(n,visit)}visit(source)
 const expected=new Map<string,number>();for(const entry of inventory.entries){const key=entry.kind+':'+entry.text;expected.set(key,(expected.get(key)||0)+1)}
 for(const [key,count]of expected)expect(counts.get(key)||0,key).toBeGreaterThanOrEqual(count)
})
