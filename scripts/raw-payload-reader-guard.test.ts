import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {rawPayloadReaderInventory} from './raw-payload-reader-guard';
it('matches the explicitly reviewed runtime and operational raw payload readers',()=>{
  const ledger=JSON.parse(readFileSync('docs/architecture/raw-payload-reader-ledger.json','utf8'));
  expect(ledger.contract).toBe('raw-payload-reader-ledger.v1');
  expect(rawPayloadReaderInventory()).toEqual(ledger.entries);
});
