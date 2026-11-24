export function shouldShowClarifyNext(input: {isLast:boolean;multi:boolean;hasOtherText:boolean}):boolean {
  return !input.isLast && (input.multi || input.hasOtherText)
}
