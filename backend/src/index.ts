import express from 'express';
import type { Request,Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
dotenv.config({
path:"./.env"
});

const app = express();
const PORT:string|number = process.env.PORT||3000;
type TcorsOptions = {
origin:string
credientials:boolean
methods : string[]
}
const corsOptions:TcorsOptions = {
origin:"*",
credientials:true,
methods:["GET","POST","PUT"]
}
app.use(express.json());
app.use(cookieParser());
app.use(morgan("combined"));
app.use(cors(corsOptions));

app.get("/",(req:Request,res:Response)=>{
res.json("backend is up and running");
});

app.listen(PORT,()=>{
console.log("Server running at PORT :",PORT);
});


