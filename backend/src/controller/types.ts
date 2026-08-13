import type { Request } from "express";

export interface SignUpRequest extends Request {
  body: {
    username: string;
    email: string;
    password: string;
  };
}

export type UserResponse = {
  id: string;
  username: string;
  email: string;
  avatarUrl: string | null;
  isVerified: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};