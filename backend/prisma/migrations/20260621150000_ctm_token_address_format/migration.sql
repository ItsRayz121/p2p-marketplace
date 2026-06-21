-- CTM token address guardrails: an example address (shown to users) and an
-- optional validation regex (JS source) used at CTM trade start so a wrong-chain
-- address can't be submitted. Additive, both nullable.
ALTER TABLE "CtmToken" ADD COLUMN "addressExample" TEXT;
ALTER TABLE "CtmToken" ADD COLUMN "addressRegex" TEXT;
