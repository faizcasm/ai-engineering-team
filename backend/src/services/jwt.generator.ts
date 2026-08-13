import jwt from 'jsonwebtoken';

export const generateToken = (userId:string,email:string)=>{
const token = jwt.sign(
    {
      userId: userId,
      email: email,
    },
    process.env.JWT_SECRET as string,
    {
      expiresIn: "7d",
    },
  );
  return token
}
