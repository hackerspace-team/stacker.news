import { PAID_ACTION_PAYMENT_METHODS } from '@/lib/constants'
import { msatsToSats, satsToMsats } from '@/lib/format'
import { Prisma } from '@prisma/client'

export const anonable = false

export const paymentMethods = [
  PAID_ACTION_PAYMENT_METHODS.FEE_CREDIT,
  PAID_ACTION_PAYMENT_METHODS.REWARD_SATS,
  PAID_ACTION_PAYMENT_METHODS.OPTIMISTIC
]

export async function getCost ({ sats }) {
  return satsToMsats(sats)
}

export async function perform ({ invoiceId, sats, id: itemId }, { me, cost, tx }) {
  itemId = parseInt(itemId)

  let invoiceData = {}
  if (invoiceId) {
    invoiceData = { invoiceId, invoiceActionState: 'PENDING' }
    // store a reference to the item in the invoice
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { actionId: itemId }
    })
  }

  const itemAct = await tx.itemAct.create({
    data: { msats: cost, itemId, userId: me.id, act: 'DONT_LIKE_THIS', ...invoiceData }
  })

  const [{ path }] = await tx.$queryRaw`SELECT ltree2text(path) as path FROM "Item" WHERE id = ${itemId}::INTEGER`
  return { id: itemId, sats, act: 'DONT_LIKE_THIS', path, actId: itemAct.id }
}

export async function retry ({ invoiceId, newInvoiceId }, { tx, cost }) {
  await tx.itemAct.updateMany({ where: { invoiceId }, data: { invoiceId: newInvoiceId, invoiceActionState: 'PENDING' } })
  const [{ id, path }] = await tx.$queryRaw`
    SELECT "Item".id, ltree2text(path) as path
    FROM "Item"
    JOIN "ItemAct" ON "Item".id = "ItemAct"."itemId"
    WHERE "ItemAct"."invoiceId" = ${newInvoiceId}::INTEGER`
  return { id, sats: msatsToSats(cost), act: 'DONT_LIKE_THIS', path }
}

export async function onPaid ({ invoice, actId }, { tx }) {
  let itemAct
  if (invoice) {
    await tx.itemAct.updateMany({ where: { invoiceId: invoice.id }, data: { invoiceActionState: 'PAID' } })
    itemAct = await tx.itemAct.findFirst({ where: { invoiceId: invoice.id }, include: { item: true } })
  } else if (actId) {
    itemAct = await tx.itemAct.findUnique({ where: { id: actId }, include: { item: true } })
  } else {
    throw new Error('No invoice or actId')
  }

  const msats = BigInt(itemAct.msats)
  const sats = msatsToSats(msats)

  // denormalize downzaps
  await tx.$executeRaw`
    WITH territory AS (
      SELECT COALESCE(r."subName", i."subName", 'meta')::CITEXT as "subName"
      FROM "Item" i
      LEFT JOIN "Item" r ON r.id = i."rootId"
      WHERE i.id = ${itemAct.itemId}::INTEGER
    ), zapper AS (
      SELECT
        COALESCE(${itemAct.item.parentId
          ? Prisma.sql`"zapCommentTrust"`
          : Prisma.sql`"zapPostTrust"`}, 0) as "zapTrust",
        COALESCE(${itemAct.item.parentId
          ? Prisma.sql`"subZapCommentTrust"`
          : Prisma.sql`"subZapPostTrust"`}, 0) as "subZapTrust"
      FROM territory
      LEFT JOIN "UserSubTrust" ust ON ust."subName" = territory."subName"
        AND ust."userId" = ${itemAct.userId}::INTEGER
    ), zap AS (
      INSERT INTO "ItemUserAgg" ("userId", "itemId", "downZapSats")
      VALUES (${itemAct.userId}::INTEGER, ${itemAct.itemId}::INTEGER, ${sats}::INTEGER)
      ON CONFLICT ("itemId", "userId") DO UPDATE
      SET "downZapSats" = "ItemUserAgg"."downZapSats" + ${sats}::INTEGER, updated_at = now()
      RETURNING LOG("downZapSats" / GREATEST("downZapSats" - ${sats}::INTEGER, 1)::FLOAT) AS log_sats
    )
    UPDATE "Item"
    SET "weightedDownVotes" = "weightedDownVotes" + zapper."zapTrust" * zap.log_sats,
        "subWeightedDownVotes" = "subWeightedDownVotes" + zapper."subZapTrust" * zap.log_sats
    FROM zap, zapper
    WHERE "Item".id = ${itemAct.itemId}::INTEGER`
}

export async function onFail ({ invoice }, { tx }) {
  await tx.itemAct.updateMany({ where: { invoiceId: invoice.id }, data: { invoiceActionState: 'FAILED' } })
}

export async function describe ({ id: itemId, sats }, { cost, actionId }) {
  return `SN: downzap of ${sats ?? msatsToSats(cost)} sats to #${itemId ?? actionId}`
}
