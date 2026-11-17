import {resolve} from 'node:path'
import {flagString} from '../args'
import {assertAllowed} from '../fs'
import {HARNESS_DATA_USAGE,runHarnessDataCommand} from '../harness-data-command'
import type {CommandDef} from '../registry'

export const dataCommand:CommandDef={
  name:'data',
  summary:'Use task-authorized Office data, inspect frozen manifests and download verified snapshots.',
  usage:HARNESS_DATA_USAGE,
  options:[{name:'args',value:'json',description:'Public data-operation arguments; credentials come only from task environment'},
    {name:'args-file',value:'file',description:'Read bounded operation JSON from a local file, including large artifact uploads'},
    {name:'out',value:'file',description:'Caller-selected local snapshot path; existing files are never overwritten'}],
  async run(args,ctx) {
    const input=flagString(args,'args-file')
    if(input)assertAllowed(resolve(ctx.cwd,input),ctx.env,'read')
    const output=flagString(args,'out')
    if(output)assertAllowed(resolve(ctx.cwd,output),ctx.env,'write')
    return runHarnessDataCommand(args,ctx)
  },
}
