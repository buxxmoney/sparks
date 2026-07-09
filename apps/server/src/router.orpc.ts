import * as A from "./admin";
import { proc, procNoInput } from "./orpc";
import { sessionCreateOrganization, sessionListMemberships, sessionMe } from "./procedures";
// The real oRPC router. Each entry wraps an existing `(ctx, input) => result`
// business function (from routers.ts / procedures.ts) as a typed oRPC procedure
// via the `proc` adapter. Shape mirrors the previous hand-rolled appRouter 1:1,
// so every call site maps unchanged — but calls are now fully typed end to end.
import * as R from "./routers";
import * as V from "./validators";

export const appRouter = {
  // Sparks-operator-only provisioning (requirePlatformOperator inside each fn).
  admin: {
    createCustomer: proc(V.adminCreateCustomerInput, A.adminCreateCustomer),
    listOrganizations: procNoInput(A.adminListOrganizations),
    listReviewQueue: procNoInput(A.adminListReviewQueue),
    reviewReconciliation: proc(V.adminReviewReconciliationInput, A.adminReviewReconciliation),
    tariffSchedulesCreate: proc(V.tariffSchedulesCreateInput, A.adminTariffSchedulesCreate),
    tariffSchedulesList: procNoInput(A.adminTariffSchedulesList),
    tariffSchedulesDelete: proc(V.tariffSchedulesDeleteInput, A.adminTariffSchedulesDelete),
  },
  session: {
    me: procNoInput(sessionMe),
    listMemberships: procNoInput(sessionListMemberships),
    createOrganization: proc(V.sessionCreateOrganizationInput, sessionCreateOrganization),
  },
  org: {
    create: proc(V.orgCreateInput, R.orgCreate),
    get: proc(V.orgGetInput, R.orgGet),
    listMembers: proc(V.orgListMembersInput, R.orgListMembers),
    invite: proc(V.orgInviteInput, R.orgInvite),
    setMemberRole: proc(V.orgSetMemberRoleInput, R.orgSetMemberRole),
    removeMember: proc(V.orgRemoveMemberInput, R.orgRemoveMember),
    accessOverview: proc(V.orgAccessOverviewInput, R.orgAccessOverview),
  },
  sites: {
    list: proc(V.sitesListInput, R.sitesList),
    get: proc(V.sitesGetInput, R.sitesGet),
    create: proc(V.sitesCreateInput, R.sitesCreate),
    update: proc(V.sitesUpdateInput, R.sitesUpdate),
    setDefaultDemandInterval: proc(
      V.sitesSetDefaultDemandIntervalInput,
      R.sitesSetDefaultDemandInterval,
    ),
    delete: proc(V.sitesDeleteInput, R.sitesDelete),
  },
  siteAccess: {
    list: proc(V.siteAccessListInput, R.siteAccessList),
    grant: proc(V.siteAccessGrantInput, R.siteAccessGrant),
    revoke: proc(V.siteAccessRevokeInput, R.siteAccessRevoke),
  },
  siteInvites: {
    create: proc(V.siteInvitesCreateInput, R.siteInvitesCreate),
    list: proc(V.siteInvitesListInput, R.siteInvitesList),
    cancel: proc(V.siteInvitesCancelInput, R.siteInvitesCancel),
    accept: proc(V.siteInvitesAcceptInput, R.siteInvitesAccept),
  },
  devices: {
    list: proc(V.devicesListInput, R.devicesList),
    get: proc(V.devicesGetInput, R.devicesGet),
    provision: proc(V.devicesProvisionInput, R.devicesProvision),
    rotateKey: proc(V.devicesRotateKeyInput, R.devicesRotateKey),
    getHealth: proc(V.devicesGetHealthInput, R.devicesGetHealth),
    updateSite: proc(V.devicesUpdateSiteInput, R.devicesUpdateSite),
  },
  meters: {
    get: proc(V.metersGetInput, R.metersGet),
    create: proc(V.metersCreateInput, R.metersCreate),
    commission: proc(V.metersCommissionInput, R.metersCommission),
  },
  billing: {
    policies: {
      get: proc(V.billingPoliciesGetInput, R.billingPoliciesGet),
      set: proc(V.billingPoliciesSetInput, R.billingPoliciesSet),
    },
    periods: {
      list: proc(V.billingPeriodsListInput, R.billingPeriodsList),
      materialize: proc(V.billingPeriodsMaterializeInput, R.billingPeriodsMaterialize),
      upsert: proc(V.billingPeriodsUpsertInput, R.billingPeriodsUpsert),
      close: proc(V.billingPeriodsCloseInput, R.billingPeriodsClose),
    },
  },
  tariffs: {
    library: {
      list: proc(V.tariffsLibraryListInput, R.tariffsLibraryList),
      get: proc(V.tariffsLibraryGetInput, R.tariffsLibraryGet),
    },
    profiles: {
      create: proc(V.tariffsProfilesCreateInput, R.tariffsProfilesCreate),
      update: proc(V.tariffsProfilesUpdateInput, R.tariffsProfilesUpdate),
      addRate: proc(V.tariffsProfilesAddRateInput, R.tariffsProfilesAddRate),
      listRates: proc(V.tariffsProfilesListRatesInput, R.tariffsProfilesListRates),
    },
    assign: {
      set: proc(V.tariffsAssignSetInput, R.tariffsAssignSet),
      list: proc(V.tariffsAssignListInput, R.tariffsAssignList),
    },
  },
  reconciliation: {
    generate: proc(V.reconciliationGenerateInput, R.reconciliationGenerate),
    get: proc(V.reconciliationGetInput, R.reconciliationGet),
    list: proc(V.reconciliationListInput, R.reconciliationList),
    listVersions: proc(V.reconciliationListVersionsInput, R.reconciliationListVersions),
    finalize: proc(V.reconciliationFinalizeInput, R.reconciliationFinalize),
    generatePdf: proc(V.reconciliationGeneratePdfInput, R.reconciliationGeneratePdf),
  },
  invoices: {
    createUpload: proc(V.invoicesCreateUploadInput, R.invoicesCreateUpload),
    uploadAndParse: proc(V.invoicesUploadAndParseInput, R.invoicesUploadAndParse),
    retryParse: proc(V.invoicesRetryParseInput, R.invoicesRetryParse),
    setPeriod: proc(V.invoicesSetPeriodInput, R.invoicesSetPeriod),
    get: proc(V.invoicesGetInput, R.invoicesGet),
    list: proc(V.invoicesListInput, R.invoicesList),
    listLineItems: proc(V.invoicesListLineItemsInput, R.invoicesListLineItems),
    updateLineItem: proc(V.invoicesUpdateLineItemInput, R.invoicesUpdateLineItem),
    confirm: proc(V.invoicesConfirmInput, R.invoicesConfirm),
    lock: proc(V.invoicesLockInput, R.invoicesLock),
    confirmReconcile: proc(V.invoicesConfirmReconcileInput, R.invoicesConfirmReconcile),
    requestReview: proc(V.invoicesRequestReviewInput, R.invoicesRequestReview),
    reopen: proc(V.invoicesReopenInput, R.invoicesReopen),
  },
  report: {
    getPdf: proc(V.reportGetPdfInput, R.reportGetPdf),
  },
  alerts: {
    list: procNoInput(R.alertsList),
    unreadCount: procNoInput(R.alertsUnreadCount),
    acknowledge: proc(V.alertsAcknowledgeInput, R.alertsAcknowledge),
    markAllRead: procNoInput(R.alertsMarkAllRead),
    attachmentUrl: proc(V.alertsAttachmentUrlInput, R.alertsAttachmentUrl),
  },
  profile: {
    setPhone: proc(V.profileSetPhoneInput, R.profileSetPhone),
  },
  readings: {
    latest: proc(V.readingsLatestInput, R.readingsLatest),
    monthToDate: proc(V.readingsMonthToDateInput, R.readingsMonthToDate),
    energyByPeriod: proc(V.readingsEnergyByPeriodInput, R.readingsEnergyByPeriod),
  },
  demand: {
    listIntervals: proc(V.demandListIntervalsInput, R.demandListIntervals),
  },
};

export type AppRouter = typeof appRouter;
