// Site-facing helpers used by valuation.html. Called only when the seller
// clicks "Proceed to Verification" — not during the in-browser engine run.

import { postAction } from './api.js';

export async function submitSellerLead(formData, valuationResult) {
  const payload = {
    practiceName: formData.practiceName,
    specialty:    formData.specialty,
    city:         formData.city,
    state:        formData.state,
    npi:          formData.npi || '',
    revenue:      Number(formData.revenue) || 0,
    visits:       Number(formData.visits) || 0,
    sites:        Number(formData.sites) || 1,
    realEstate:   formData.realEstate,
    timeline:     formData.timeline,
    email:        formData.email,
    valuationLow:        valuationResult.low,
    valuationHigh:       valuationResult.high,
    valuationPoint:      valuationResult.pointEstimate,
    methodology:         valuationResult.methodology,
    enrichment:          valuationResult.enrichment,
    factors:             valuationResult.factors,
    dataSources:         valuationResult.dataSources
  };
  return postAction('seller_submit', payload);
}

export async function notifyEngineError(err, formData) {
  try {
    await postAction('engine_error', {
      error: {
        message: err?.message || String(err),
        stack:   err?.stack || null
      },
      formData
    });
  } catch (_) {
    // Best-effort; never throw from an error reporter.
  }
}
