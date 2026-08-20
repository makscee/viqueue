#!/usr/bin/env node
import { Store } from '../src/store.js';
const args=process.argv.slice(2);const option=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined};
const storage=option('--storage')??process.env.VIQ_STORAGE;const id=option('--id');const name=option('--name');
if(!storage||!id||!name){console.error('usage: viq-bootstrap --storage FILE --id DEVICE --name NAME');process.exit(2)}
const store=new Store(storage);await store.init();try{const result=await store.bootstrapCoordinator({id,name});process.stdout.write(`${JSON.stringify(result)}\n`)}finally{await store.close()}
