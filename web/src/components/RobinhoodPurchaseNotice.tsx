import type { AssetDescriptor } from "@steward/shared";

export type PurchaseLocationAnswer = "" | "restricted" | "not-listed" | "unsure";

export function isRobinhoodStockPurchase(asset: AssetDescriptor | undefined, side: "BUY" | "SELL") {
  if (side !== "BUY" || !asset || asset.legalInstrumentType === "settlement_token") return false;
  // Live holdings currently label non-settlement tokens "unclassified"; the only
  // configured mainnet buy routes are Robinhood stock-token routes.
  return asset.provider === "robinhood" || (asset.chainId === 4663 && asset.provider === "unclassified");
}

/** A self-report can stop a request; it never establishes legal eligibility. */
export function locationAnswerDoesNotBlockQuote(answer: PurchaseLocationAnswer) {
  return answer === "not-listed";
}

export function RobinhoodPurchaseNotice({ answer, onAnswer }: { answer: PurchaseLocationAnswer; onAnswer: (answer: PurchaseLocationAnswer) => void }) {
  return <aside className="notice" aria-labelledby="robinhood-purchase-restriction">
    <strong id="robinhood-purchase-restriction">Before a Robinhood Stock Token purchase</strong>
    <p>Robinhood says these tokens cannot be offered or sold in the U.S. or to, or for the benefit of, U.S. persons. Sales are also restricted in other places, including Canada, the U.K. and Switzerland. Check the <a href="https://docs.robinhood.com/rhj/restricted-jurisdictions/" target="_blank" rel="noreferrer">current full list and terms</a>.</p>
    <label>Does a restriction on that list apply to the parent, caregiver, or anyone for whose benefit this purchase would be made?
      <select value={answer} onChange={(event) => onAnswer(event.target.value as PurchaseLocationAnswer)}>
        <option value="">Choose an answer</option>
        <option value="restricted">Yes, a restriction applies</option>
        <option value="not-listed">No listed restriction applies</option>
        <option value="unsure">I am not sure</option>
      </select>
    </label>
    {answer === "restricted" ? <p role="alert"><strong>Purchase unavailable.</strong> Steward will not request a quote or prepare this purchase.</p> : null}
    {answer === "unsure" ? <p role="alert"><strong>Purchase unavailable until clarified.</strong> Steward will not request a quote or prepare this purchase.</p> : null}
    {answer === "not-listed" ? <p>Your answer is not an eligibility approval. Steward's independent asset and market checks must still allow the purchase.</p> : null}
    {!answer ? <p>A purchase quote stays unavailable until you answer. This self-report does not replace any required verification.</p> : null}
  </aside>;
}
