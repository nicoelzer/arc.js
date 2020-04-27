import { Observable, from } from 'rxjs'
import gql from 'graphql-tag'
import { first, concatMap } from 'rxjs/operators'
import {
  IProposalState,
  Proposal,
  Arc,
  IApolloQueryOptions,
  secondSinceEpochToDate,
  NULL_ADDRESS,
  CompetitionVote,
  ITransactionReceipt,
  getEventArgs,
  ITransaction,
  toIOperationObservable,
  Operation,
  CompetitionSuggestion,
  ICompetitionSuggestionQueryOptions,
  DAO,
  Competition,
  Plugin,
  IContributionRewardExtState,
  CONTRIBUTION_REWARD_DUMMY_VERSION,
  REDEEMER_CONTRACT_VERSIONS,
  Address
} from '../../index'
import { DocumentNode } from 'graphql'
import { ContributionRewardExt } from '../contributionRewardExt'

export interface ICompetitionProposalState extends IProposalState { 
  id: string
  admin: Address
  contract: Address
  endTime: Date
  numberOfWinners: number
  rewardSplit: number[]
  startTime: Date
  votingStartTime: Date
  suggestionsEndTime: Date
  numberOfVotesPerVoter: number
  snapshotBlock: number
  createdAt: Date
  totalVotes: number
  totalSuggestions: number
  numberOfWinningSuggestions: number
}

export class CompetitionProposal extends Proposal<ICompetitionProposalState> {

  private static _fragment: { name: string, fragment: DocumentNode } | undefined

  public static get fragment () {
   if(!this._fragment){
    this._fragment = {
      name: 'CompetitionProposalFields',
      fragment: gql`
        fragment CompetitionProposalFields on Proposal {
          competition {
            id
            admin
            endTime
            contract
            suggestionsEndTime
            createdAt
            numberOfWinningSuggestions
            numberOfVotesPerVoters
            numberOfWinners
            rewardSplit
            snapshotBlock
            startTime
            totalSuggestions
            totalVotes
            votingStartTime
    
          }
        }
      `
    }
   }

   return this._fragment
     
  }

  static itemMap (context: Arc, item: any, query: DocumentNode): ICompetitionProposalState | null {

    if (!item) {
      console.log(`Competition Proposal ItemMap failed.`)
      return null
    }
    
    if (!item.contributionReward) throw new Error(`Unexpected proposal state: competition is set, but contributionReward is not`)
 
    const competitionState = ContributionRewardExt.itemMap(context, item.scheme, query)

    if(!competitionState) return null
    
    const competition = new Competition(context, competitionState)
    const competitionProposal = new CompetitionProposal(context, item.id)

    const baseState = Proposal.itemMapToBaseState(
      context,
      item,
      competition,
      competitionProposal,
      "Competition"
    )

    if(baseState == null) return null
    
    return {
      ...baseState,
      admin: item.competition.admin,
      contract: item.competition.contract,
      createdAt: secondSinceEpochToDate(item.competition.createdAt),
      endTime: secondSinceEpochToDate(item.competition.endTime),
      id: item.competition.id,
      numberOfVotesPerVoter: Number(item.competition.numberOfVotesPerVoters),
      numberOfWinners: Number(item.competition.numberOfWinners),
      numberOfWinningSuggestions: Number(item.competition.numberOfWinningSuggestions),
      rewardSplit: item.competition.rewardSplit.map((perc: string) => Number(perc)),
      plugin: {
        id: competition.id,
        entity: competition
      },
      snapshotBlock: item.competition.snapshotBlock,
      startTime: secondSinceEpochToDate(item.competition.startTime),
      suggestionsEndTime: secondSinceEpochToDate(item.competition.suggestionsEndTime),
      totalSuggestions: Number(item.competition.totalSuggestions),
      totalVotes: Number(item.competition.totalVotes),
      votingStartTime: secondSinceEpochToDate(item.competition.votingStartTime)
    }
  }

  public state(apolloQueryOptions: IApolloQueryOptions): Observable<ICompetitionProposalState> {
    const query = gql`query ProposalState
      {
        proposal(id: "${this.id}") {
          ...ProposalFields
          votes {
            id
          }
          stakes {
            id
          }
        }
      }
      ${Proposal.baseFragment}
      ${Plugin.baseFragment}
    `

    const result = this.context.getObservableObject(this.context, query, CompetitionProposal.itemMap, apolloQueryOptions) as Observable<ICompetitionProposalState>
    return result
  }

  private async getState() {
    if(!this.coreState) throw new Error("Cannot get plugin state if competitionProposal's coreState is not set")

    return await this.coreState.plugin.entity.fetchState({}, true) as IContributionRewardExtState
  }

  public redeemerContract() {
    for (const version of REDEEMER_CONTRACT_VERSIONS) {
      try {
        const contractInfo = this.context.getContractInfoByName('Redeemer', version)
        return this.context.getContract(contractInfo.address)
      } catch (err) {
        if (!err.message.match(/no contract/i)) {
          // if the contract cannot be found, try the next one
          throw err
        }
      }
    }
    throw Error(`No Redeemer contract could be found (search for versions ${REDEEMER_CONTRACT_VERSIONS})`)
  }

  public suggestions(
    options: ICompetitionSuggestionQueryOptions = {},
    apolloQueryOptions: IApolloQueryOptions = {}
  ): Observable<CompetitionSuggestion[]> {
    if (!options.where) { options.where = {} }
    options.where.proposal = this.id
    return CompetitionSuggestion.search(this.context, options, apolloQueryOptions)
  }

  public redeemRewards(beneficiary?: Address): Operation<boolean> {

    const mapReceipt = (receipt: ITransactionReceipt) => true

    const createTransaction = async (): Promise<ITransaction> => {
      if (!beneficiary) {
        beneficiary = NULL_ADDRESS
      }

      const state = await this.fetchState()
      const pluginAddress = this.context.getContractInfoByName('ContributionReward', CONTRIBUTION_REWARD_DUMMY_VERSION).address
      const method = 'redeem'
      const args = [
        pluginAddress,
        state.votingMachine,
        this.id,
        beneficiary
      ]

      return {
        contract: this.redeemerContract(),
        method,
        args
      }
    }

    const observable = from(createTransaction()).pipe(
      concatMap((transaction) => {
        return this.context.sendTransaction(transaction, mapReceipt)
      })
    )

    return toIOperationObservable(observable)
  }

  public createSuggestion(options: {
    title: string,
    description: string,
    beneficiary?: Address,
    tags?: string[],
    url?: string
  }): Operation<CompetitionSuggestion> {

    const mapReceipt = async (receipt: ITransactionReceipt) => {
      const pluginState = await this.getState()
      const args = getEventArgs(receipt, 'NewSuggestion', 'Competition.createSuggestion')
      const suggestionId = args[1]
      return new CompetitionSuggestion(this.context, {
        plugin: (pluginState).id,
        suggestionId
      })
    }

    const errorHandler = async (err: Error) => {
      const pluginState = await this.getState()
      const contract = Competition.getCompetitionContract(this.context, pluginState)
      const proposal = await contract.proposals(this.id)
      if (!proposal) {
        throw Error(`A proposal with id ${this.id} does not exist`)
      }
      throw err
    }

    const createTransaction = async (): Promise<ITransaction> => {
      if (!options.beneficiary) {
        options.beneficiary = await this.context.getAccount().pipe(first()).toPromise()
      }
      const pluginState = await this.getState()
      const contract = Competition.getCompetitionContract(this.context, pluginState)
      const descriptionHash = await this.context.saveIPFSData(options)
      return {
        contract,
        method: 'suggest',
        args: [ this.id, descriptionHash, options.beneficiary ]
      }
    }

    const observable = from(createTransaction()).pipe(
      concatMap((transaction) => {
        return this.context.sendTransaction(
          transaction, mapReceipt, errorHandler
        )
      })
    )

    return toIOperationObservable(observable)
  }

  public voteSuggestion(options: {
    suggestionId: number // this is the suggestion COUNTER
  }): Operation<CompetitionVote> {

    const mapReceipt = (receipt: ITransactionReceipt) => {
      const [
        proposal,
        suggestionId,
        voter,
        reputation
      ] = getEventArgs(receipt, 'NewVote', 'Competition.voteSuggestion')

      const suggestion = CompetitionSuggestion.calculateId({
        plugin: this.id,
        suggestionId
      })

      return new CompetitionVote(this.context, {
        //TODO: where to get this ID?
        id: '',
        proposal,
        reputation,
        suggestion,
        voter
      })
    }

    const errorHandler = async (err: Error) => {
      const pluginState = await this.getState()
      const contract = await Competition.getCompetitionContract(this.context, pluginState)
      // see if the suggestionId does exist in the contract
      const suggestion = await contract.suggestions(options.suggestionId)
      if (suggestion.proposalId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        throw Error(`A suggestion with suggestionId ${options.suggestionId} does not exist`)
      }

      // check if the sender has reputation in the DAO
      const state = await this.fetchState() as ICompetitionProposalState

      if(!state.dao.entity.coreState) throw new Error("DAO in CompetitionProposal state has not state set")

      const dao = new DAO(this.context, state.dao.entity.coreState)
      const reputation = await dao.nativeReputation().pipe(first()).toPromise()
      const sender = await this.context.getAccount().pipe(first()).toPromise()
      const reputationOfUser = await reputation.reputationOf(sender).pipe(first()).toPromise()
      if (reputationOfUser.isZero()) {
        throw Error(`Cannot vote because the user ${sender} does not have any reputation in the DAO at ${dao.id}`)
      }
      return err
    }

    const createTransaction = async (): Promise<ITransaction> => {
      const pluginState = await this.getState()
      const contract = await Competition.getCompetitionContract(this.context, pluginState)
      return {
        contract,
        method: 'vote',
        args: [ options.suggestionId ]
      }
    }

    const observable = from(createTransaction()).pipe(
      concatMap((transaction) => {
        return this.context.sendTransaction(transaction, mapReceipt, errorHandler)
      })
    )

    return toIOperationObservable(observable)
  }

  public redeemSuggestion(options: {
    suggestionId: number // this is the suggestion COUNTER
  }): Operation<boolean> {

    const mapReceipt = (receipt: ITransactionReceipt) => {
      if (!receipt.events || receipt.events.length === 0) {
        throw Error('Competition.redeemSuggestion: missing events in receipt')
      } else {
        return true
      }
    }

    const errorHandler = async (err: Error) => {
      const pluginState = await this.getState()
      const contract = await Competition.getCompetitionContract(this.context, pluginState)
      // see if the suggestionId does exist in the contract
      const suggestion = await contract.suggestions(options.suggestionId)
      if (suggestion.proposalId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        throw Error(`A suggestion with suggestionId ${options.suggestionId} does not exist`)
      }
      return err
    }

    const createTransaction = async (): Promise<ITransaction> => {
      const pluginState = await this.getState()
      const contract = await Competition.getCompetitionContract(this.context, pluginState)
      return {
        contract,
        method: 'redeem',
        args: [ options.suggestionId ]
      }
    }

    const observable = from(createTransaction()).pipe(
      concatMap((transaction) => {
        return this.context.sendTransaction(transaction, mapReceipt, errorHandler)
      })
    )

    return toIOperationObservable(observable)
  }

  public mapReceipt = async (receipt: ITransactionReceipt) => {
    const args = getEventArgs(receipt, 'NewSuggestion', 'Competition.createSuggestion')
    const suggestionId = args[1]
    return new CompetitionSuggestion(this.context, suggestionId)
  }

  public errorHandler = async (err: Error) => {
    const pluginState = await this.getState()
    const contract = Competition.getCompetitionContract(this.context, pluginState)
    const proposal = await contract.proposals(this.id)
    if (!proposal) {
      throw Error(`A proposal with id ${this.id} does not exist`)
    }
    throw err
  }

}