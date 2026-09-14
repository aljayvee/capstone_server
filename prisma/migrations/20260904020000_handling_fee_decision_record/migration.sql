-- The handling fee learns to account for itself, and to respect what the
-- customer agreed to.
--
-- quotedHandlingBasket / quotedHandlingFee: stamped when the customer confirms
-- the itemised breakdown (errandService.confirmOrder), and never exceeded after.
-- markItemsPurchased overwrites estimatedCost with the REAL receipt total, and
-- it does so AFTER the rider has already bought the goods — there is no moment
-- left in which to ask for consent to a bigger number. Before this, a P1,000
-- estimate ringing up at P1,200 moved the fee from P50 to P120 with nobody
-- deciding it. The ceiling is a one-way ratchet: a smaller real basket still
-- lowers the fee.
--
-- handlingFeeDecision: mode, tier, basket, evidence, what the rule alone
-- produced, the relief cap, the ceiling, and which one won. "Why P50 and not
-- 10%?" is a question the dispatcher, the owner and the customer all end up
-- asking, and the fee used to arrive as a bare figure with no account of itself.
--
-- All three are nullable. Errands priced before this migration keep pricing
-- exactly as they did: decideHandlingFee reads a null ceiling as "no ceiling".
ALTER TABLE `errands` ADD COLUMN `handlingFeeDecision` JSON NULL,
    ADD COLUMN `quotedHandlingBasket` DOUBLE NULL,
    ADD COLUMN `quotedHandlingFee` DOUBLE NULL;
