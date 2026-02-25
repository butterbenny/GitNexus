import Axios from 'axios';

export const fetchPayoutAccount = (accountId: number) => {
  return Axios.get(`/accounts/${accountId}/payout_account`);
};
