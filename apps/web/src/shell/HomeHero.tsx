import {useEffect,useState} from 'react'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import {generateHomeHero,type HomeHeroCopy} from './home-hero'

export function HomeHero({fallback,language,request,csrfToken,enabled=true}:{fallback:HomeHeroCopy;language:string;request:SettingsRequest;csrfToken:string;enabled?:boolean}){
 const [generated,setGenerated]=useState<{language:string;copy:HomeHeroCopy}|null>(null)
 useEffect(()=>{
  if(!enabled)return
  const controller=new AbortController()
  void generateHomeHero({request,csrfToken,language,hour:new Date().getHours(),signal:controller.signal}).then(copy=>{
   if(copy&&!controller.signal.aborted)setGenerated({language,copy})
  })
  return()=>controller.abort()
 },[request,csrfToken,language,enabled])
 const copy=generated?.language===language?generated.copy:fallback
 return <h1 className="hero-title">{copy.greeting}<span className="hero-ask">{copy.guidance}</span></h1>
}
