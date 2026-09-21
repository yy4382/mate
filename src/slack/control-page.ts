/** Preserve complete JSON and continuation through Slack's bounded ephemeral reply path. */
export function controlPage<T extends {cursor:number}>(rows:T[],limit=20):string {
  const items:T[]=[];
  for(const row of rows){
    if(items.length===limit)break;
    const candidate=[...items,row];
    if(JSON.stringify({items:candidate,nextCursor:row.cursor}).length>12000){
      if(!items.length)throw new Error('Management item exceeds reply budget');
      break;
    }
    items.push(row);
  }
  return JSON.stringify({items,nextCursor:items.length<rows.length?items.at(-1)?.cursor??null:null});
}
