import crypto from "crypto";

export const generateOtp = (length: number): string => {
    const max = 10 ** length;

    return crypto.randomInt(0, max)
        .toString()
        .padStart(length, "0");
};

