import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { generateWithHealing } from '../../src/guardian'

const orderSchema = z.object({
	orderId: z.string().min(1),
	status: z.enum(['pending', 'confirmed', 'cancelled']),
	items: z
		.array(
			z.object({
				sku: z.string().min(1),
				quantity: z.number().int().positive()
			})
		)
		.min(1)
})

describe('generateWithHealing smoke flow', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})
	it('recovers from malformed output and schema violations to return a valid nested payload', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})

		const simulatedResponses = [
			'Sure! Here is your order: {orderId: ORD-1}',
			'```json\n{"orderId": "ORD-1", "status": "unknown", "items": []}\n```',
			'```json\n{"orderId": "ORD-1", "status": "confirmed", "items": [{"sku": "SKU-99", "quantity": 2}]}\n```'
		]

		let callIndex = 0
		const llmCaller = async (prompt: string): Promise<string> => {
			if (callIndex === 1) {
				expect(prompt).toContain('not valid parsable JSON')
			}
			if (callIndex === 2) {
				expect(prompt).toContain('failed schema validation')
				expect(prompt).toContain('status:')
				expect(prompt).toContain('items:')
			}
			return simulatedResponses[callIndex++] ?? ''
		}

		const result = await generateWithHealing('Generate order summary', orderSchema, {
			maxRetries: 2,
			llmCaller
		})

		expect(callIndex).toBe(3)
		expect(result).toEqual({
			orderId: 'ORD-1',
			status: 'confirmed',
			items: [{ sku: 'SKU-99', quantity: 2 }]
		})
	})
})
