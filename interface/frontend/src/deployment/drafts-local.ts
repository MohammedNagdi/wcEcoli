type BrowserDrafts=typeof import('../explorer/drafts')
function unavailable():never {throw new Error('Personal browser drafts are available only in the explorer profile')}
export const getDraft:BrowserDrafts['getDraft']=async()=>unavailable()
export const saveDraft:BrowserDrafts['saveDraft']=async()=>unavailable()
export const makeDraft:BrowserDrafts['makeDraft']=()=>unavailable()
export const downloadDrafts:BrowserDrafts['downloadDrafts']=async()=>unavailable()
