const names=new Map<string,string>()
export const rememberReferenceName=(id:string,name:string)=>{names.set(id,name)}
export const referenceLabel=(value:string)=>value.startsWith('draft:')?'My '+(names.get(value.slice(6))||'saved reference'):value
