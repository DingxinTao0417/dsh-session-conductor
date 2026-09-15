import { z } from 'zod'
import { EXECUTION_STATES, INTERACTION_STATES, TURN_OUTCOMES } from '../domain/state.ts'
import { initialProjection, type ProjectionState, type NotableEvent } from './projection.ts'

const seq=z.number().int().min(-1)
const event=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('turn_started'),turn:z.number().int()}),
  z.object({kind:z.literal('turn_ended'),turn:z.number().int(),outcome:z.enum(TURN_OUTCOMES),detail:z.string()}),
  z.object({kind:z.literal('approval_asked'),approvalId:z.string(),toolName:z.string().optional()}),
  z.object({kind:z.literal('user_question'),callId:z.string(),toolName:z.string()}),
  z.object({kind:z.literal('artifact_accepted'),artifactId:z.string(),by:z.string()}),
])
export interface TaskObservation {
  taskId:string;sessionId:string;position:number;throughSeq:number;state:ProjectionState
  notable:{seq:number;event:NotableEvent;at?:number;reportTriggered:boolean}[]
  bindingVersion:number;ownerEpoch:number;truncated:boolean
}
export const taskObservationSchema=z.object({
  taskId:z.string().min(1),sessionId:z.string().min(1),position:seq,throughSeq:seq,
  state:z.object({execution:z.enum(EXECUTION_STATES),interaction:z.enum(INTERACTION_STATES),waitingCallId:z.string().optional(),
    lastTurn:z.enum(TURN_OUTCOMES).optional(),lastTurnDetail:z.string().optional(),cursor:seq,turnsStarted:z.number().int().nonnegative(),
    openTurn:z.number().int().optional(),openTurnStartSeq:seq.optional()}).strict(),
  notable:z.array(z.object({seq,event,at:z.number().optional(),reportTriggered:z.boolean()}).strict()).max(1000),
  bindingVersion:z.number().int().nonnegative(),ownerEpoch:z.number().int().nonnegative(),truncated:z.boolean(),
}).strict().superRefine((value,ctx)=>{
  if(value.throughSeq>value.position || value.state.cursor!==value.position
    || value.notable.some((entry,index)=>entry.seq>value.throughSeq || index>0 && entry.seq<value.notable[index-1]!.seq))ctx.addIssue({code:'custom',message:'invalid observation sequence bounds'})
}).transform((value):TaskObservation=>({...value,state:{...initialProjection(),...value.state},notable:value.notable.map(entry=>({seq:entry.seq,event:entry.event as NotableEvent,
  reportTriggered:entry.reportTriggered,...entry.at===undefined?{}:{at:entry.at}}))}))

export function encodeObservationCursor(sessionId:string,position:number):string {
  return `remote:${Buffer.from(sessionId,'utf8').toString('base64url')}:${position}`
}
/** A predecessor's numeric/session cursor cannot suppress events from the successor. */
export function observationAfterCursor(cursor:string,sessionId:string):number {
  const match=/^remote:([A-Za-z0-9_-]+):(-?\d+)$/.exec(cursor)
  if(!match || Buffer.from(match[1]!,'base64url').toString('utf8')!==sessionId)return -1
  const value=Number(match[2]);return Number.isSafeInteger(value) && value>=-1?value:-1
}
