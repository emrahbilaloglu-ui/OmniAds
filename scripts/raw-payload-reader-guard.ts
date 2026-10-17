/** Review boundary for every literal raw-payload SQL consumer. It deliberately
 * covers operational scripts too; a newly discovered read requires review. */
import {readdirSync,readFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
export function rawPayloadReaderInventory(root=process.cwd()) {
  const result:{path:string;sha256:string;readers:number}[]=[];
  const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name),rel=relative(root,path);
    if(entry.isDirectory())walk(path);
    else if(/\.tsx?$/.test(path)&&!/(?:\.test\.|seam|fixture|migrations\.ts$|raw-payload-reader-guard)/.test(rel)){
      const source=readFileSync(path,'utf8'),file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);
      let readers=0;
      const visit=(node:ts.Node)=>{
        if(ts.isNoSubstitutionTemplateLiteral(node)||ts.isTemplateExpression(node)||ts.isStringLiteral(node)){
          const sql=node.getText(file);
          if(/\b(?:FROM|JOIN)\s+(?:public\.)?(?:meta|shopify)_raw_snapshots\b/i.test(sql)&&
            /\bSELECT\b/i.test(sql)&&/\bpayload_json\b|\bSELECT\s+(?:\w+\.)?\*/i.test(sql))readers++;
        }
        ts.forEachChild(node,visit);
      };visit(file);
      if(readers)result.push({path:rel,sha256:createHash('sha256').update(source).digest('hex'),readers});
    }
  }};
  for(const dir of ['app','lib','scripts'])walk(join(root,dir));
  return result.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
