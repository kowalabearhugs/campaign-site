import { NextApiRequest, NextApiResponse } from 'next'
import getRawBody from 'raw-body'
import crypto from 'crypto'
import dayjs from 'dayjs'

import {
  BtcPayGetRatesRes,
  BtcPayGetPaymentMethodsRes,
  DonationMetadata,
} from '../../../server/types'
import { btcpayApi as _btcpayApi, btcpayApi, prisma } from '../../../server/services'
import { env } from '../../../env.mjs'

export const config = {
  api: {
    bodyParser: false,
  },
}

type BtcpayBody = Record<string, any> & {
  deliveryId: string
  webhookId: string
  originalDeliveryId: string
  isRedelivery: boolean
  type: string
  timestamp: number
  storeId: string
  invoiceId: string
  metadata: DonationMetadata
}

async function handleBtcpayWebhook(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    res.status(405).end(`Method ${req.method} Not Allowed`)
    return
  }

  if (typeof req.headers['btcpay-sig'] !== 'string') {
    res.status(400).json({ success: false })
    return
  }

  const rawBody = await getRawBody(req)
  const body: BtcpayBody = JSON.parse(Buffer.from(rawBody).toString('utf8'))

  const expectedSigHash = crypto
    .createHmac('sha256', env.BTCPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')

  const incomingSigHash = (req.headers['btcpay-sig'] as string).split('=')[1]

  if (expectedSigHash !== incomingSigHash) {
    console.error('Invalid signature')
    res.status(400).json({ success: false })
    return
  }

  if (body.type === 'InvoicePaymentSettled') {
    // Handle payments to funding required API invoices ONLY
    if (body.metadata.staticGeneratedForApi === 'false') {
      return res.status(200).json({ success: true })
    }

    const cryptoCode = body.paymentMethod === 'BTC-OnChain' ? 'BTC' : 'XMR'

    const { data: rates } = await btcpayApi.get<BtcPayGetRatesRes>(
      `/rates?currencyPair=${cryptoCode}_USD`
    )

    const cryptoRate = Number(rates[0].rate)
    const cryptoAmount = Number(body.payment.value)
    const fiatAmount = Number((cryptoAmount * cryptoRate).toFixed(2))

    await prisma.donation.create({
      data: {
        userId: null,
        btcPayInvoiceId: body.invoiceId,
        projectName: body.metadata.projectName,
        projectSlug: body.metadata.projectSlug,
        fundSlug: body.metadata.fundSlug,
        cryptoCode,
        grossCryptoAmount: cryptoAmount,
        grossFiatAmount: fiatAmount,
        netCryptoAmount: cryptoAmount,
        netFiatAmount: fiatAmount,
      },
    })
  }

  if (body.type === 'InvoiceSettled') {
    // If this is a funding required API invoice, let InvoiceReceivedPayment handle it instead
    if (body.metadata.staticGeneratedForApi === 'true') {
      return res.status(200).json({ success: true })
    }

    const { data: paymentMethods } = await btcpayApi.get<BtcPayGetPaymentMethodsRes>(
      `/invoices/${body.invoiceId}/payment-methods`
    )

    // Create one donation and one point history for each invoice payment method
    await Promise.all(
      paymentMethods.map(async (paymentMethod) => {
        const shouldGivePointsBack = body.metadata.givePointsBack === 'true'
        const cryptoRate = Number(paymentMethod.rate)
        const grossCryptoAmount = Number(paymentMethod.amount)
        const grossFiatAmount = grossCryptoAmount * cryptoRate
        // Deduct 10% of amount if donator wants points
        const netCryptoAmount = shouldGivePointsBack ? grossCryptoAmount * 0.9 : grossCryptoAmount
        const netFiatAmount = netCryptoAmount * cryptoRate

        // Move on if amound paid with current method is 0
        if (!grossCryptoAmount) return

        const pointsAdded = shouldGivePointsBack
          ? parseInt(String(Number(grossFiatAmount.toFixed(2)) * 100))
          : 0

        const donation = await prisma.donation.create({
          data: {
            userId: body.metadata.userId,
            btcPayInvoiceId: body.invoiceId,
            projectName: body.metadata.projectName,
            projectSlug: body.metadata.projectSlug,
            fundSlug: body.metadata.fundSlug,
            cryptoCode: paymentMethod.cryptoCode,
            grossCryptoAmount: Number(grossCryptoAmount.toFixed(2)),
            grossFiatAmount: Number(grossFiatAmount.toFixed(2)),
            netCryptoAmount: Number(netCryptoAmount.toFixed(2)),
            netFiatAmount: Number(netFiatAmount.toFixed(2)),
            pointsAdded,
            membershipExpiresAt:
              body.metadata.isMembership === 'true' ? dayjs().add(1, 'year').toDate() : null,
          },
        })

        // Add points
        if (shouldGivePointsBack && body.metadata.userId) {
          // Get balance for project/fund by finding user's last point history
          const lastPointHistory = await prisma.pointHistory.findFirst({
            where: {
              userId: body.metadata.userId,
              fundSlug: body.metadata.fundSlug,
              projectSlug: body.metadata.projectSlug,
              pointsAdded: { gt: 0 },
            },
            orderBy: { createdAt: 'desc' },
          })

          const currentBalance = lastPointHistory ? lastPointHistory.pointsBalance : 0

          await prisma.pointHistory.create({
            data: {
              donationId: donation.id,
              userId: body.metadata.userId,
              fundSlug: body.metadata.fundSlug,
              projectSlug: body.metadata.projectSlug,
              pointsAdded,
              pointsBalance: currentBalance + pointsAdded,
            },
          })
        }
      })
    )
  }

  res.status(200).json({ success: true })
}

export default handleBtcpayWebhook
