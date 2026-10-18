-- AlterTable
ALTER TABLE "CreditEntry" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "Source" ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SourceGrant" ADD COLUMN     "canUpload" BOOLEAN NOT NULL DEFAULT false;
