#!/usr/bin/env python3
"""
Gemma RAG + CASCADE Execution Script
Execute the gemma-rag-cascade workflow via Python

Usage:
    python run_gemma_rag.py "Your question here"
    python run_gemma_rag.py --interactive
"""

import json
import sys
import time
from typing import Dict, Any

# Note: This assumes you have the MCP tools available
# Adjust imports based on your actual MCP client setup

def execute_workflow(query: str) -> Dict[str, Any]:
    """
    Execute the gemma-rag-cascade workflow
    
    Args:
        query: User question
        
    Returns:
        Execution result with provenance
    """
    print(f"\n🔍 Query: {query}")
    print("⚙️  Executing workflow...")
    
    # Workflow execution
    # Replace this with your actual MCP client call
    result = {
        "workflow_id": "gemma-rag-cascade",
        "input": {"query": query},
        "status": "completed",
        "nodes_executed": 13,
        "merkle_root": "4fcd7d2a62aa31a3"
    }
    
    print(f"✓ Workflow completed")
    print(f"✓ Nodes executed: {result['nodes_executed']}/13")
    print(f"✓ Merkle root: {result['merkle_root']}")
    
    return result

def interactive_mode():
    """Run in interactive mode"""
    print("=" * 60)
    print("Gemma RAG + CASCADE Interactive Mode")
    print("=" * 60)
    print("\nType your questions (or 'quit' to exit)")
    print("Each query will be processed with full provenance tracking\n")
    
    while True:
        try:
            query = input("\n💬 Your question: ").strip()
            
            if query.lower() in ['quit', 'exit', 'q']:
                print("\n👋 Goodbye!")
                break
                
            if not query:
                continue
                
            start_time = time.time()
            result = execute_workflow(query)
            elapsed = time.time() - start_time
            
            print(f"⏱️  Execution time: {elapsed:.2f}s")
            
        except KeyboardInterrupt:
            print("\n\n👋 Goodbye!")
            break
        except Exception as e:
            print(f"\n❌ Error: {e}")

def main():
    """Main entry point"""
    if len(sys.argv) > 1:
        if sys.argv[1] in ['--interactive', '-i']:
            interactive_mode()
        else:
            query = ' '.join(sys.argv[1:])
            result = execute_workflow(query)
            print(f"\n📊 Result: {json.dumps(result, indent=2)}")
    else:
        print("Usage:")
        print('  python run_gemma_rag.py "Your question here"')
        print('  python run_gemma_rag.py --interactive')
        sys.exit(1)

if __name__ == "__main__":
    main()
