-- CreateTable
CREATE TABLE "WebPresence" (
    "userId" TEXT NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebPresence_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "WebPresence" ADD CONSTRAINT "WebPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
