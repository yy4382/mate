import {createRequire} from 'node:module';

interface EmojiData {aliases:Record<string,string>;emojis:Record<string,{skins:{native:string}[]}>}
// Pin the dataset with the lockfile. Unknown/custom shortcodes retain their spelling.
const data=createRequire(import.meta.url)('@emoji-mart/data') as EmojiData;
function plainText(text:string):string {
  return text
    .replace(/:([\w+-]+):(?::skin-tone-([2-6]):)?/g,(whole:string,name:string,tone:string|undefined)=>{
      const entry=data.emojis[data.aliases[name]??name];
      return entry?.skins[tone?Number(tone)-1:0]?.native??whole;
    })
    .replace(/\ufe0f/g,'')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
}
function equivalentText(text:string):string {
  const urls=text.replace(/<(https?:\/\/[^<>|\s]+)(?:\|([^<>]*))?>/g,(whole:string,url:string,label:string|undefined)=>label===undefined||label===url?url:whole);
  // Preserve active Slack syntax before decoding entities. Structured segments prevent
  // escaped literal mentions from becoming control tokens (without sentinel collisions).
  return JSON.stringify(urls.split(/(<[^<>\n]+>)/g).map((part,index)=>
    index%2 ? ['control',part] : ['text',plainText(part)]));
}
/** Only documented platform representation changes, never arbitrary rewritten content.
 * https://docs.slack.dev/messaging/formatting-message-text/
 */
export function slackTextMatches(expected:string,observed:string):boolean {
  return equivalentText(expected)===equivalentText(observed);
}
