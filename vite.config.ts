import { defineConfig } from 'vite'
import {viteXStateClient} from "./examples/viewer/vite-xstate-plugin";
// import dotenv from "dotenv";
 // dotenv.config();

console.log(process.env.AZURE_OPENAI_API_KEY);
export default defineConfig( {
    root: 'examples/viewer',
    envDir: '.',
    envPrefix: 'AZURE',
    plugins: [viteXStateClient() ],
    
})
