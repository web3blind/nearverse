import {useCallback, useEffect, useRef, useState, type ComponentType} from 'react';
import type {FinancialPanelProps} from './FinancialPanel';
import {probeRecovery, observeRecovery, mergeRecovery, type RecoveryObservation} from './recoveryProbe';

export function useFinancialActivation() {
  const [Panel,setPanel] = useState<ComponentType<FinancialPanelProps>|null>(null);
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState('');
  const [connectRequest,setConnectRequest] = useState(0);
  const [recovery,setRecovery] = useState(probeRecovery);
  const observedRecovery=useRef(observeRecovery({entries:Object.create(null),blocked:false},recovery));
  const [activationRecoveryBlocked,setActivationRecoveryBlocked]=useState(observedRecovery.current.blocked);
  const converterActive=useRef(false);
  // FinancialPanel can exist while the second lazy boundary is still pending.
  // Stop startup observation only once the converter owns live recovery/removal.
  const onRecoveryActivated=useCallback((accepted:RecoveryObservation,canOwn:(final:RecoveryObservation)=>boolean)=>{
    // Called only after live listeners and actual pending state own recovery,
    // or the converter has permanently fenced the observed startup evidence.
    const final=observeRecovery(mergeRecovery(observedRecovery.current,accepted),probeRecovery());
    observedRecovery.current=final;
    setActivationRecoveryBlocked(final.blocked);
    // Ownership must cover the final probe, not the caller's earlier snapshot.
    // A newly discovered pending record still belongs to startup observation.
    converterActive.current=canOwn(final);
    return final;
  },[]);
  const inFlight=useRef(false);
  function checkRecovery(){
    const next=probeRecovery();
    if(!converterActive.current){
      observedRecovery.current=observeRecovery(observedRecovery.current,next);
      setActivationRecoveryBlocked(observedRecovery.current.blocked);
    }
    setRecovery(next);
  }
  useEffect(()=>{
    window.addEventListener('storage',checkRecovery);window.addEventListener('focus',checkRecovery);
    return ()=>{window.removeEventListener('storage',checkRecovery);window.removeEventListener('focus',checkRecovery);};
  },[]);
  async function activate(){
    if(inFlight.current)return;
    checkRecovery();
    setError('');setConnectRequest(value=>value+1);
    if(Panel)return;
    inFlight.current=true;setLoading(true);
    try {
      const module=await import('./FinancialPanel');
      checkRecovery();
      setPanel(()=>module.FinancialPanel);
    }catch{setError('The wallet module could not be loaded. Retry NEAR wallet connection. No signature was requested.');}
    finally{inFlight.current=false;setLoading(false);}
  }
  return {Panel,activate,loading,error,connectRequest,recovery,activationRecoveryBlocked,activationRecoveryEntries:observedRecovery.current.entries,onRecoveryActivated};
}
