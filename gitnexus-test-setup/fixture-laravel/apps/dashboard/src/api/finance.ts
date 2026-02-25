import Axios from 'axios';

export const fetchFinancialAccountSummary = (accountId: number, financialAccountId: number) => {
  return Axios.get<{ ok: boolean }>(`/accounts/${accountId}/financial_accounts/${financialAccountId}/summary`);
};
